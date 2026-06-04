/* netlify/functions/test-whatsapp.mjs
 * --------------------------------------------------------------
 * TESTE/DEMONSTRAÇÃO sob demanda do fluxo completo:
 *   alarme → telemetria do dispositivo → diagnóstico IA → WhatsApp
 *
 * Acesse:
 *   /api/test-whatsapp            → mensagem com rótulo [TESTE]
 *   /api/test-whatsapp?modo=real  → idêntica à de produção (sem rótulo)
 *
 * Também SALVA o contexto (Blobs), então logo após receber o diagnóstico
 * você pode RESPONDER no WhatsApp e o chatbot já terá o contexto. Ótimo
 * para demonstrar o ciclo inteiro ao vivo sem esperar o cron.
 *
 * Env: TWILIO_*, ALERT_WHATSAPP_TO, GEMINI_API_KEY
 * --------------------------------------------------------------
 */

import { getStore } from "@netlify/blobs";
import {
  fetchAlarmes, fetchUnidades, fetchTelemetria, processData,
  analisarTelemetria, resumirTelemetria, gerarDiagnostico, diagnosticoFactual,
  buildAlertHeader, sendWhatsApp, normNumero,
} from "../lib/galileo.mjs";

function json(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default async (req) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ALERT_WHATSAPP_TO;

  const modoReal = new URL(req.url).searchParams.get("modo") === "real";

  const faltando = [];
  if (!sid) faltando.push("TWILIO_ACCOUNT_SID");
  if (!token) faltando.push("TWILIO_AUTH_TOKEN");
  if (!from) faltando.push("TWILIO_WHATSAPP_FROM");
  if (!to) faltando.push("ALERT_WHATSAPP_TO");
  if (faltando.length) return json(500, { ok: false, erro: "Variáveis ausentes", faltando });

  try {
    const [alarmesRaw, unidadesRaw] = await Promise.all([fetchAlarmes(), fetchUnidades()]);
    const { alarmes } = processData(alarmesRaw, unidadesRaw);
    const criticos = alarmes.filter((a) => a.criticidade === "Crítica" || a.criticidade === "Alta");
    if (!criticos.length) return json(200, { ok: false, mensagem: "Nenhum alarme crítico ativo agora." });

    const alarme = criticos[0];

    // telemetria + análise + diagnóstico
    let analise = null;
    let resumoTel = "Telemetria indisponível.";
    if (alarme.dispositivoId) {
      try {
        const tel = await fetchTelemetria(alarme.dispositivoId);
        analise = analisarTelemetria(tel);
        resumoTel = resumirTelemetria(analise);
      } catch (e) {
        console.error("[test] telemetria falhou:", e.message);
      }
    }
    // factual por padrão; IA só se habilitada (mesma regra do monitor)
    const aiOn = String(process.env.AI_DIAGNOSIS_ENABLED ?? "true").toLowerCase() !== "false";
    let diagnostico = diagnosticoFactual(alarme, analise);
    if (aiOn) {
      const ia = await gerarDiagnostico(alarme, resumoTel);
      if (ia) diagnostico = ia;
    }

    const body =
      buildAlertHeader(alarme, { teste: !modoReal }) +
      `\n\n🤖 *Diagnóstico:*\n${diagnostico}\n\n` +
      `_Responda esta mensagem para falar com o assistente._\n` +
      `_Galileo Watch · ${modoReal ? "monitoramento automático" : "mensagem de teste"}_`;

    const r = await sendWhatsApp({ sid, token, from, to, body });

    // salva contexto para o chatbot responder logo após o teste
    if (r.ok) {
      const ctx = {
        lojaNm: alarme.lojaApelido || alarme.lojaNm, lojaId: alarme.lojaId,
        dispositivoId: alarme.dispositivoId, dispositivoNm: alarme.dispositivoNm,
        alarmeDesc: alarme.alarmeDesc, criticidade: alarme.criticidade, tempo: alarme.tempo,
        diagnostico, resumoTelemetria: resumoTel, ts: Date.now(),
      };
      const ctxStore = getStore("galileo-chat-contexto");
      const payload = JSON.stringify(ctx);
      await ctxStore.set(`ctx:${normNumero(to)}`, payload).catch(() => {});
      await ctxStore.set("ctx:ultimo", payload).catch(() => {});
    }

    return json(r.ok ? 200 : 502, {
      ok: r.ok,
      mensagem: r.ok
        ? "Diagnóstico enviado! Verifique o WhatsApp. Se não chegar, veja twilio_status (janela de 24h do sandbox)."
        : "Falha ao enviar — veja 'twilio' abaixo.",
      twilio_status: r.status || null,
      twilio_erro: r.twilio?.code ? `${r.twilio.code}: ${r.twilio.message || ""}` : null,
      dispositivo_analisado: alarme.dispositivoId,
      preview: body,
      destino: to,
    });
  } catch (e) {
    return json(502, { ok: false, erro: e.message });
  }
};
