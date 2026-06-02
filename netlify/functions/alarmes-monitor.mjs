/* netlify/functions/alarmes-monitor.mjs
 * --------------------------------------------------------------
 * MONITOR DE ALARMES com DIAGNÓSTICO POR IA — notificação WhatsApp.
 *
 * Roda a cada 5 minutos. Para cada alarme crítico NOVO:
 *   1. usa o dispositivoId do alarme para buscar a telemetria dele
 *   2. analisa a telemetria (temperatura vs setpoint, tendência, etc)
 *   3. pede ao Gemini um diagnóstico técnico do problema
 *   4. envia ao responsável: cabeçalho do alarme + diagnóstico da IA
 *   5. salva o contexto (Blobs) para o chatbot responder perguntas depois
 *
 * Dedupe via Blobs (store "alarmes-notificados") + bootstrap na 1ª exec.
 * Contexto do chat via Blobs (store "galileo-chat-contexto").
 *
 * Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
 *      ALERT_WHATSAPP_TO, GEMINI_API_KEY
 * --------------------------------------------------------------
 */

import { getStore } from "@netlify/blobs";
import {
  fetchAlarmes, fetchUnidades, fetchTelemetria, processData,
  analisarTelemetria, resumirTelemetria, gerarDiagnostico,
  buildAlertHeader, sendWhatsApp, normNumero,
} from "../lib/galileo.mjs";

export const config = {
  schedule: "*/5 * * * *", // a cada 5 minutos
};

const CRITICIDADES_ALERTA = ["Crítica", "Alta"];
const MAX_POR_EXECUCAO = 3; // cada alarme faz fetch de telemetria + Gemini, então limitamos

export default async () => {
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

  let enviados = 0, novos = 0;
  for (const a of criticos) {
    if (enviados >= MAX_POR_EXECUCAO) break;
    const key = `a:${a.alarmeId}`;
    if (await store.get(key).catch(() => null)) continue;
    novos++;

    // 1-2. telemetria do dispositivo + análise
    let resumoTel = "Telemetria indisponível.";
    if (a.dispositivoId) {
      try {
        const tel = await fetchTelemetria(a.dispositivoId);
        resumoTel = resumirTelemetria(analisarTelemetria(tel));
      } catch (e) {
        console.error("[monitor] telemetria falhou p/ disp", a.dispositivoId, e.message);
      }
    }

    // 3. diagnóstico por IA (com fallback se Gemini indisponível)
    const diagnostico =
      (await gerarDiagnostico(a, resumoTel)) ||
      "Verifique o equipamento: a leitura indica condição fora do esperado para a operação normal.";

    // 4. mensagem = cabeçalho + diagnóstico
    const body =
      buildAlertHeader(a) +
      `\n\n🤖 *Diagnóstico:*\n${diagnostico}\n\n` +
      `_Responda esta mensagem para falar com o assistente._\n` +
      `_Galileo Watch · monitoramento automático_`;

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

  console.log(`[monitor] ${novos} novo(s), ${enviados} notificado(s)`);
  return new Response(`ok: ${enviados} notificados de ${novos} novos`);
};
