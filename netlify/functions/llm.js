/* netlify/functions/llm.js
 * --------------------------------------------------------------
 * Recebe { question, chunks } do front, monta prompt aumentado
 * e chama o Gemini 2.5 Flash. Retorna { answer, model }.
 *
 * A chave fica em process.env.GEMINI_API_KEY (variável configurada
 * no Netlify env vars). NUNCA expor ao client.
 *
 * Esta function é o estágio "Generation" do pipeline RAG:
 *   front → retrieval (TF-IDF) → top-K chunks → llm.js → Gemini → resposta
 * --------------------------------------------------------------
 */

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: "GEMINI_API_KEY não configurada nas variáveis de ambiente do Netlify",
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
    const upstream = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.2,    // baixa pra respostas factuais e determinísticas
          maxOutputTokens: 800,
          topP: 0.95,
        },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
        ],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error("[llm] Gemini error:", upstream.status, errText);
      return jsonResponse(upstream.status, {
        error: `Gemini API erro ${upstream.status}`,
        detail: errText.slice(0, 500),
      });
    }

    const data = await upstream.json();
    const answer = extractText(data);

    return jsonResponse(200, {
      answer,
      model: GEMINI_MODEL,
    });
  } catch (err) {
    console.error("[llm] erro fetching Gemini:", err);
    return jsonResponse(502, {
      error: "falha ao contatar Gemini",
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

  return `Você é um assistente especializado em monitoramento de refrigeração comercial da plataforma Galileo (EletroFrio).
Responda à pergunta do operador usando APENAS as informações dos trechos numerados abaixo.
Se a informação não estiver disponível nos trechos, diga isso claramente em vez de inventar.
Cite os números dos trechos entre colchetes quando relevante (ex: "[1] indica que...").
Seja conciso, técnico e direto — máximo 6 frases.
Use formatação simples (sem markdown elaborado), em português do Brasil.

Trechos disponíveis:
${chunkText}

Pergunta do operador: ${question}

Resposta:`;
}

function extractText(geminiResponse) {
  try {
    const candidates = geminiResponse.candidates || [];
    if (!candidates.length) {
      // pode ter sido bloqueado por safety
      const block = geminiResponse.promptFeedback?.blockReason;
      return block ? `Resposta bloqueada por filtro de segurança (${block}).` : "Sem resposta do modelo.";
    }
    const parts = candidates[0].content?.parts || [];
    const text = parts.map((p) => p.text || "").join("").trim();
    return text || "Resposta vazia do modelo.";
  } catch (e) {
    return "Erro ao processar resposta do modelo.";
  }
}
