/* netlify/functions/llm.js
 * --------------------------------------------------------------
 * Recebe { question, chunks } do front, monta prompt aumentado
 * e chama o Claude Haiku 4.5. Retorna { answer, model }.
 *
 * A chave fica em process.env.ANTHROPIC_API_KEY (variável configurada
 * no Netlify env vars). NUNCA expor ao client.
 *
 * Esta function é o estágio "Generation" do pipeline RAG:
 *   front → retrieval (TF-IDF) → top-K chunks → llm.js → Claude → resposta
 * --------------------------------------------------------------
 */

const Anthropic = require("@anthropic-ai/sdk");

const CLAUDE_MODEL = "claude-haiku-4-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: "ANTHROPIC_API_KEY não configurada nas variáveis de ambiente do Netlify",
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "JSON inválido" });
  }

  const { question, chunks } = payload;
  if (!question || typeof question !== "string") {
    return jsonResponse(400, { error: "campo 'question' (string) é obrigatório" });
  }
  if (!Array.isArray(chunks)) {
    return jsonResponse(400, { error: "campo 'chunks' (array) é obrigatório" });
  }

  const prompt = buildPrompt(question, chunks);

  try {
    const client = new Anthropic({ apiKey, timeout: 10000, maxRetries: 1 });
    const msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });

    const answer = extractText(msg);

    return jsonResponse(200, {
      answer,
      model: CLAUDE_MODEL,
    });
  } catch (err) {
    console.error("[llm] erro ao contatar Claude:", err);
    return jsonResponse(502, {
      error: "falha ao contatar Claude",
      message: err.message,
    });
  }
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function buildPrompt(question, chunks) {
  const chunkText = chunks
    .slice(0, 8)
    .map((c, i) => `[${i + 1}] (${c.type || "info"}) ${c.text}`)
    .join("\n\n");

  return `Você é o assistente do Freezer Controle, plataforma de monitoramento de refrigeração comercial.
O operador costuma fazer perguntas abertas ou analíticas (perguntas diretas de contagem e listagem já são respondidas automaticamente pelo sistema).
Responda usando APENAS as informações dos trechos numerados abaixo. Se algo não estiver nos trechos, diga isso claramente, sem inventar.
Quando útil, relacione os dados (por exemplo, lojas críticas e contratos a vencer) para dar uma leitura da situação.
Cite os números dos trechos entre colchetes quando fizer sentido (ex: "[1] mostra...").
Seja conciso e direto, em português do Brasil, sem markdown elaborado — no máximo 6 frases.

Trechos disponíveis:
${chunkText}

Pergunta do operador: ${question}

Resposta:`;
}

function extractText(msg) {
  try {
    const parts = msg.content || [];
    const text = parts
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("")
      .trim();
    return text || "Resposta vazia do modelo.";
  } catch (e) {
    return "Erro ao processar resposta do modelo.";
  }
}
