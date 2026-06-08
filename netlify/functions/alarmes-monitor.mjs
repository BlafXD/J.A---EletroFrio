/* netlify/functions/alarmes-monitor.mjs
 * --------------------------------------------------------------
 * MONITOR DE ALARMES com DIAGNÓSTICO POR IA — notificação WhatsApp.
 *
 * Roda a cada 5 minutos. Para cada alarme crítico NOVO:
 *   1. usa o dispositivoId do alarme para buscar a telemetria dele
 *   2. analisa a telemetria (temperatura vs setpoint, tendência, etc)
 *   3. pede ao Claude um diagnóstico técnico do problema
 *   4. envia ao responsável: cabeçalho do alarme + diagnóstico da IA
 *   5. salva o contexto (Blobs) para o chatbot responder perguntas depois
 *
 * Dedupe via Blobs (store "alarmes-notificados") + bootstrap na 1ª exec.
 * Contexto do chat via Blobs (store "galileo-chat-contexto").
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
 *      ALERT_WHATSAPP_TO, ANTHROPIC_API_KEY
 * --------------------------------------------------------------
 */

import { getStore } from "@netlify/blobs";
import {
  fetchAlarmes, fetchUnidades, fetchTelemetria, processData,
  analisarTelemetria, resumirTelemetria, gerarDiagnostico, diagnosticoFactual,
  buildAlertHeader, sendWhatsApp, normNumero,
} from "../lib/galileo.mjs";

export const config = {
  schedule: "*/5 * * * *", // a cada 5 minutos
};

const CRITICIDADES_ALERTA = ["Crítica", "Alta"];
const MAX_POR_EXECUCAO = 3; // máx. de alarmes PROCESSADOS por execução (limita custo/quota)

// Interruptores via env var (sem redeploy: muda no painel do Netlify e vale no próximo ciclo).
//   ALERTS_ENABLED=false        → desliga TODO envio automático de WhatsApp (kill switch)
//   AI_DIAGNOSIS_ENABLED=false  → não chama o Claude; usa só o diagnóstico factual (zero custo de IA)
const ALERTS_ENABLED = String(process.env.ALERTS_ENABLED ?? "true").toLowerCase() !== "false";
const AI_DIAGNOSIS_ENABLED = String(process.env.AI_DIAGNOSIS_ENABLED ?? "true").toLowerCase() !== "false";

export default async () => {
  // Kill switch: pausa o envio automático sem precisar remover o cron nem redeployar.
  if (!ALERTS_ENABLED) {
    console.log("[monitor] ALERTS_ENABLED=false — envio automático desativado, nada enviado.");
    return new Response("alerts disabled (ALERTS_ENABLED=false)");
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ALERT_WHATSAPP_TO;

  if (!sid || !token || !from || !to) {
    console.error("[monitor] variáveis Twilio ausentes");
    return new Response("Config Twilio ausente", { status: 500 });
  }

  let alarmesRaw, unidadesRaw;
  try {
    [alarmesRaw, unidadesRaw] = await Promise.all([fetchAlarmes(), fetchUnidades()]);
  } catch (e) {
    console.error("[monitor] falha ao buscar endpoints:", e.message);
    return new Response("Falha ao buscar dados", { status: 502 });
  }

  const { alarmes } = processData(alarmesRaw, unidadesRaw);
  const criticos = alarmes.filter((a) => a.alarmeId && CRITICIDADES_ALERTA.includes(a.criticidade));

  const store = getStore("alarmes-notificados");
  const ctxStore = getStore("galileo-chat-contexto");

  // bootstrap: 1ª execução marca tudo sem enviar
  const bootstrap = await store.get("__bootstrap_done").catch(() => null);
  if (!bootstrap) {
    for (const a of criticos) await store.set(`a:${a.alarmeId}`, new Date().toISOString());
    await store.set("__bootstrap_done", new Date().toISOString());
    console.log(`[monitor] bootstrap: ${criticos.length} alarmes marcados, 0 enviados`);
    return new Response(`bootstrap ok (${criticos.length} marcados)`);
  }

  let enviados = 0, novos = 0, tentativas = 0;
  for (const a of criticos) {
    if (tentativas >= MAX_POR_EXECUCAO) break; // limita TENTATIVAS por ciclo (não só envios)
    const key = `a:${a.alarmeId}`;
    if (await store.get(key).catch(() => null)) continue;
    novos++;
    tentativas++;

    // 1-2. telemetria do dispositivo + análise factual
    let analise = null;
    let resumoTel = "Telemetria indisponível.";
    if (a.dispositivoId) {
      try {
        const tel = await fetchTelemetria(a.dispositivoId);
        analise = analisarTelemetria(tel);
        resumoTel = resumirTelemetria(analise);
      } catch (e) {
        console.error("[monitor] telemetria falhou p/ disp", a.dispositivoId, e.message);
      }
    }

    // 3. o diagnóstico FACTUAL por regras é sempre a base (usa os números reais
    //    da telemetria, não inventa). A IA só entra se habilitada — assim, com
    //    AI_DIAGNOSIS_ENABLED=false, o Claude não é chamado (zero custo de IA).
    let diagnostico = diagnosticoFactual(a, analise);
    if (AI_DIAGNOSIS_ENABLED) {
      const diagnosticoIA = await gerarDiagnostico(a, resumoTel);
      if (diagnosticoIA) diagnostico = diagnosticoIA;
    }

    // 4. mensagem = cabeçalho + diagnóstico + link para o painel da loja
    const siteUrl = (process.env.URL || "https://radiant-sunburst-1294db.netlify.app").replace(/\/$/, "");
    const linkLoja = a.lojaId ? `${siteUrl}/loja.html?lojaId=${encodeURIComponent(a.lojaId)}` : siteUrl;
    const body =
      buildAlertHeader(a) +
      `\n\n🤖 *Diagnóstico:*\n${diagnostico}\n\n` +
      `📊 Saiba mais (gráficos e telemetria da loja):\n${linkLoja}\n\n` +
      `_Responda esta mensagem para falar com o assistente._\n` +
      `_Freezer Controle · monitoramento automático_`;

    const r = await sendWhatsApp({ sid, token, from, to, body });
    if (r.ok) {
      await store.set(key, new Date().toISOString());
      enviados++;

      // 5. salva contexto para o chatbot (por número + global p/ a demo)
      const ctx = {
        lojaNm: a.lojaApelido || a.lojaNm, lojaId: a.lojaId,
        dispositivoId: a.dispositivoId, dispositivoNm: a.dispositivoNm,
        alarmeDesc: a.alarmeDesc, criticidade: a.criticidade, tempo: a.tempo,
        diagnostico, resumoTelemetria: resumoTel, ts: Date.now(),
      };
      const payload = JSON.stringify(ctx);
      await ctxStore.set(`ctx:${normNumero(to)}`, payload).catch(() => {});
      await ctxStore.set("ctx:ultimo", payload).catch(() => {});
    }
  }

  console.log(`[monitor] ${novos} novo(s), ${enviados} notificado(s), ${tentativas} tentativa(s)`);
  return new Response(`ok: ${enviados} notificados de ${novos} novos`);
};
