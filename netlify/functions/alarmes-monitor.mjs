/* netlify/functions/alarmes-monitor.mjs
 * --------------------------------------------------------------
 * MONITOR DE ALARMES — notificação proativa por WhatsApp.
 *
 * Roda automaticamente a cada 5 minutos (Scheduled Function).
 * A cada execução:
 *   1. busca alarmes + unidades dos endpoints Galileo
 *   2. cruza (JOIN) e filtra os de criticidade Alta/Crítica
 *   3. para cada alarme AINDA NÃO notificado, envia mensagem WhatsApp
 *      ao cliente e marca como notificado (Netlify Blobs)
 *
 * Por que Blobs e não comparação de horário?
 *   Como a function é stateless, precisamos de memória persistente
 *   entre execuções para saber o que já foi avisado. Blobs guarda os
 *   alarmeIds já notificados — sem depender de timezone (o campo
 *   alarmeDhCad vem sem fuso, o que tornaria a comparação frágil).
 *
 * Bootstrap: na PRIMEIRA execução, marca todos os alarmes atuais como
 *   "já vistos" sem enviar nada — evita disparar 100+ mensagens de uma
 *   vez ao ligar o sistema. A partir da 2ª execução, só os novos geram
 *   notificação.
 *
 * Variáveis de ambiente necessárias (Netlify → Environment variables):
 *   GEMINI_API_KEY        (já existe — opcional aqui)
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_WHATSAPP_FROM  ex: whatsapp:+14155238886  (número do sandbox)
 *   ALERT_WHATSAPP_TO     ex: whatsapp:+5541999999999 (cliente/destino)
 * --------------------------------------------------------------
 */

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "*/5 * * * *", // a cada 5 minutos
};

const GALILEO_BASE =
  "https://credenciamento.eletrofrio.com.br:5900/galileo/api/api_hackathon";
const CRITICIDADES_ALERTA = ["Crítica", "Alta"];
const MAX_POR_EXECUCAO = 5; // evita flood se muitos alarmes novos aparecerem juntos

export default async () => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ALERT_WHATSAPP_TO;

  if (!sid || !token || !from || !to) {
    console.error("[monitor] variáveis Twilio ausentes — configure no Netlify env vars");
    return new Response("Config Twilio ausente", { status: 500 });
  }

  let alarmesRaw, unidadesRaw;
  try {
    [alarmesRaw, unidadesRaw] = await Promise.all([
      fetch(`${GALILEO_BASE}?route=alarmes`, { headers: { Accept: "application/json" } }).then((r) => r.json()),
      fetch(`${GALILEO_BASE}?route=unidades`, { headers: { Accept: "application/json" } }).then((r) => r.json()),
    ]);
  } catch (e) {
    console.error("[monitor] falha ao buscar endpoints:", e.message);
    return new Response("Falha ao buscar dados", { status: 502 });
  }

  const data = processData(
    Array.isArray(alarmesRaw) ? alarmesRaw : [],
    Array.isArray(unidadesRaw) ? unidadesRaw : []
  );
  const criticos = data.alarmes.filter(
    (a) => a.alarmeId && CRITICIDADES_ALERTA.includes(a.criticidade)
  );

  const store = getStore("alarmes-notificados");

  // ---- bootstrap: primeira execução marca tudo sem enviar ----
  const bootstrap = await store.get("__bootstrap_done").catch(() => null);
  if (!bootstrap) {
    for (const a of criticos) {
      await store.set(`a:${a.alarmeId}`, new Date().toISOString());
    }
    await store.set("__bootstrap_done", new Date().toISOString());
    console.log(`[monitor] bootstrap: ${criticos.length} alarmes marcados, 0 enviados`);
    return new Response(`bootstrap ok (${criticos.length} marcados)`);
  }

  // ---- detectar e notificar novos ----
  let enviados = 0;
  let novos = 0;
  for (const a of criticos) {
    if (enviados >= MAX_POR_EXECUCAO) break;

    const key = `a:${a.alarmeId}`;
    const visto = await store.get(key).catch(() => null);
    if (visto) continue;

    novos++;
    const msg = buildAlertMessage(a);
    const ok = await sendWhatsApp({ sid, token, from, to, body: msg });
    if (ok) {
      await store.set(key, new Date().toISOString());
      enviados++;
    }
  }

  console.log(`[monitor] ${novos} novo(s) detectado(s), ${enviados} notificado(s)`);
  return new Response(`ok: ${enviados} notificados de ${novos} novos`);
};

/* ============ processamento (igual ao webhook) ============ */
function clean(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? null : t;
  }
  return v;
}
function toDate(v) {
  if (!v) return null;
  const d = new Date(String(v).replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
function normCrit(v) {
  if (!v && v !== 0) return null;
  const s = String(v).trim().toLowerCase();
  if (s === "c" || s.startsWith("crit")) return "Crítica";
  if (s === "a" || s.startsWith("alta") || s === "high") return "Alta";
  if (s === "m" || s.startsWith("med")) return "Média";
  if (s === "b" || s.startsWith("baixa") || s === "low") return "Baixa";
  if (s === "i" || s.startsWith("inf")) return "Informativa";
  return String(v).trim();
}

function processData(alarmesRaw, unidadesRaw) {
  const unidades = unidadesRaw.map((u) => ({
    lojaId: clean(u.lojaId),
    lojaNm: clean(u.lojaNm),
    lojaApelido: clean(u.lojaApelido),
    contaNm: clean(u.contaNm),
    tpContratoNm: clean(u.tpContratoNm),
    dtValContrato: toDate(u.dtValContrato),
    dhSinalVida: toDate(u.dhSinalVida),
  }));

  const uIdx = new Map();
  for (const u of unidades) if (u.lojaId != null) uIdx.set(String(u.lojaId), u);

  const alarmes = alarmesRaw.map((a) => {
    const u = a.lojaId != null ? uIdx.get(String(a.lojaId)) : null;
    return {
      alarmeId: clean(a.alarmeId),
      lojaId: clean(a.lojaId),
      lojaNm: clean(a.lojaNm),
      lojaApelido: clean(a.lojaApelido),
      contaNm: clean(a.contaNm),
      dispositivoNm: clean(a.dispositivoNm),
      grupoNm: clean(a.grupoNm),
      subgrupoNm: clean(a.subgrupoNm),
      alarmeDesc: clean(a.alarmeDesc),
      criticidade: normCrit(a.criticidade),
      tempo: clean(a.tempo),
      loja_contrato: u?.tpContratoNm || null,
      loja_dtValContrato: u?.dtValContrato || null,
      loja_dhSinalVida: u?.dhSinalVida || null,
    };
  });

  return { alarmes, unidades };
}

/* ============ mensagem ============ */
function buildAlertMessage(a) {
  const loja = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
  const grupo = [a.grupoNm, a.subgrupoNm].filter(Boolean).join(" / ") || "—";

  let contratoLinha = "";
  if (a.loja_contrato) {
    contratoLinha = `\n📋 Contrato: ${a.loja_contrato}`;
    if (a.loja_dtValContrato) {
      const dias = Math.round((a.loja_dtValContrato.getTime() - Date.now()) / 86400000);
      if (dias >= 0 && dias <= 60) contratoLinha += ` (vence em ${dias} dias)`;
    }
  }

  const sinalLinha = a.loja_dhSinalVida
    ? `\n📡 Último sinal de vida: ${a.loja_dhSinalVida.toLocaleString("pt-BR")}`
    : "";

  return (
    `🚨 *ALARME ${a.criticidade ? a.criticidade.toUpperCase() : ""}* — ${loja}\n\n` +
    `📍 Dispositivo: ${a.dispositivoNm || "—"}\n` +
    `🔧 Tipo: ${a.alarmeDesc || "—"}\n` +
    `📂 Grupo: ${grupo}\n` +
    `⏱️ Aberto há: ${a.tempo || "—"}` +
    contratoLinha +
    sinalLinha +
    `\n\n⚠️ Risco de perda de produto perecível. Verificação recomendada.\n` +
    `_Galileo Watch · monitoramento automático_`
  );
}

/* ============ envio Twilio (REST, sem dependência) ============ */
async function sendWhatsApp({ sid, token, from, to, body }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({ From: from, To: to, Body: body });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      console.error("[monitor] twilio erro", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("[monitor] falha ao enviar WhatsApp:", e.message);
    return false;
  }
}
