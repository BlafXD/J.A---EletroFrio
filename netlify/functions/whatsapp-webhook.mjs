/* netlify/functions/whatsapp-webhook.mjs
 * --------------------------------------------------------------
 * CHATBOT CONTEXTUAL — responde o responsável da loja via WhatsApp.
 *
 * Quando o dono responde a uma notificação (ou manda qualquer mensagem),
 * o Twilio chama este webhook. O bot:
 *   1. recupera o CONTEXTO do último alarme notificado àquele número
 *      (Blobs — gravado pelo alarmes-monitor)
 *   2. rebusca a telemetria ATUAL do dispositivo daquele alarme
 *   3. pede ao Gemini uma resposta no contexto do alarme + telemetria
 *   4. responde via TwiML
 *
 * Não precisa de credenciais Twilio (resposta via TwiML é só o corpo HTTP).
 * Usa GEMINI_API_KEY.
 * --------------------------------------------------------------
 */

import { getStore } from "@netlify/blobs";
import {
  fetchTelemetria, analisarTelemetria, resumirTelemetria,
  responderPergunta, escapeXml, normNumero,
} from "../lib/galileo.mjs";

function twiml(message) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export default async (req) => {
  if (req.method !== "POST") {
    return twiml("Envie uma mensagem de texto para falar com o assistente Galileo Watch.");
  }

  // Twilio envia application/x-www-form-urlencoded
  let params;
  try {
    const text = await req.text();
    params = new URLSearchParams(text);
  } catch {
    return twiml("Não consegui ler sua mensagem. Tente novamente.");
  }

  const pergunta = (params.get("Body") || "").trim();
  const from = params.get("From") || "";
  console.log(`[webhook] de ${from}: "${pergunta}"`);

  if (!pergunta) {
    return twiml("Olá! Sou o assistente Galileo Watch. 🛰️ Pergunte sobre o alarme do seu equipamento.");
  }

  // 1. contexto do último alarme notificado a este número (fallback: último global)
  const ctxStore = getStore("galileo-chat-contexto");
  let ctx = null;
  try {
    const raw =
      (await ctxStore.get(`ctx:${normNumero(from)}`)) ||
      (await ctxStore.get("ctx:ultimo"));
    if (raw) ctx = JSON.parse(raw);
  } catch (e) {
    console.error("[webhook] erro ao ler contexto:", e.message);
  }

  if (!ctx) {
    return twiml(
      "Ainda não há um alarme recente associado a este número para eu comentar. " +
        "Assim que um alarme do seu equipamento for detectado, você receberá o diagnóstico aqui e poderá me perguntar sobre ele."
    );
  }

  // 2. telemetria ATUAL do dispositivo do contexto
  let resumoAtual = ctx.resumoTelemetria || null;
  if (ctx.dispositivoId) {
    try {
      const tel = await fetchTelemetria(ctx.dispositivoId);
      resumoAtual = resumirTelemetria(analisarTelemetria(tel));
    } catch (e) {
      console.error("[webhook] telemetria atual falhou:", e.message);
    }
  }

  // 3. resposta no contexto (fallback se Gemini indisponível)
  const resposta =
    (await responderPergunta(pergunta, ctx, resumoAtual)) ||
    `Sobre o alarme em ${ctx.dispositivoNm || "seu equipamento"}: ${ctx.diagnostico || "verifique o equipamento."}`;

  return twiml(resposta);
};
