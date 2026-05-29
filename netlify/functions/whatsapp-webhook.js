/* netlify/functions/whatsapp-webhook.js
 * --------------------------------------------------------------
 * Webhook que o Twilio chama quando uma mensagem chega no WhatsApp.
 *
 * Pipeline RAG completo, 100% server-side (porque o WhatsApp não tem
 * navegador para rodar o RAG client-side):
 *
 *   1. Twilio faz POST aqui com { Body, From, ... } (form-urlencoded)
 *   2. fetchData()   — busca alarmes + unidades dos endpoints Galileo
 *   3. processData() — normaliza criticidade, trim, JOIN alarmes×unidades
 *   4. buildSummary()+ buildChunks() — gera contexto agregado + chunks
 *   5. retrieve()    — TF-IDF cosseno, top-K chunks
 *   6. callGemini()  — síntese com Gemini 2.5 Flash
 *   7. responde TwiML (XML) — o Twilio entrega o texto ao usuário
 *
 * Não precisa de credenciais Twilio: a resposta via TwiML é só o
 * corpo HTTP. A chave do Gemini vem de process.env.GEMINI_API_KEY.
 * --------------------------------------------------------------
 */

const GALILEO_BASE =
  "https://credenciamento.eletrofrio.com.br:5900/galileo/api/api_hackathon";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

exports.handler = async (event) => {
  // O Twilio sempre chama via POST
  if (event.httpMethod !== "POST") {
    return twiml("Envie uma mensagem de texto para consultar o sistema Galileo.");
  }

  // Twilio manda form-urlencoded; pode vir base64
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf-8")
    : event.body || "";
  const params = new URLSearchParams(rawBody);
  const question = (params.get("Body") || "").trim();
  const from = params.get("From") || "desconhecido";

  console.log(`[whatsapp] de ${from}: "${question}"`);

  if (!question) {
    return twiml(
      "Olá! Sou o assistente Galileo Watch. 🛰️\n\n" +
        "Pergunte algo como:\n" +
        "• Quais lojas têm mais alarmes críticos?\n" +
        "• Quantos contratos vencem em 30 dias?\n" +
        "• Há dispositivos sem sinal de vida?"
    );
  }

  try {
    // 1. busca dados frescos (só alarmes + unidades — telemetria é por device)
    const { alarmes, unidades } = await fetchData();

    // 2. processa
    const data = processData(alarmes, unidades);

    // 3. contexto: resumo agregado + chunks recuperados
    const summary = buildSummary(data);
    const chunks = buildChunks(data);
    const retrieved = retrieve(question, chunks, 6);

    // 4. Gemini
    const answer = await callGemini(question, summary, retrieved);

    return twiml(answer);
  } catch (err) {
    console.error("[whatsapp] erro:", err);
    return twiml(
      "Tive um problema ao consultar o sistema agora. Tente de novo em alguns instantes."
    );
  }
};

/* ============ coleta ============ */
async function fetchData() {
  const [alarmes, unidades] = await Promise.all([
    fetch(`${GALILEO_BASE}?route=alarmes`, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .catch(() => []),
    fetch(`${GALILEO_BASE}?route=unidades`, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .catch(() => []),
  ]);
  return {
    alarmes: Array.isArray(alarmes) ? alarmes : [],
    unidades: Array.isArray(unidades) ? unidades : [],
  };
}

/* ============ processamento (versão enxuta do processor.js) ============ */
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
      ativo: true, // a API só devolve alarmes ativos/recentes
      loja_contrato: u?.tpContratoNm || null,
      loja_dtValContrato: u?.dtValContrato || null,
      loja_dhSinalVida: u?.dhSinalVida || null,
    };
  });

  return { alarmes, unidades };
}

/* ============ contexto agregado ============ */
function buildSummary(data) {
  const now = Date.now();
  const DAY = 86400000;
  const ativos = data.alarmes;
  const criticos = ativos.filter(
    (a) => a.criticidade === "Alta" || a.criticidade === "Crítica"
  ).length;

  // top 5 lojas por alarmes
  const porLoja = new Map();
  for (const a of ativos) {
    const n = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
    porLoja.set(n, (porLoja.get(n) || 0) + 1);
  }
  const top = [...porLoja.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([n, q]) => `${n} (${q})`)
    .join(", ");

  const contratos30 = data.unidades.filter((u) => {
    if (!u.dtValContrato) return false;
    const t = u.dtValContrato.getTime();
    return t >= now && t <= now + 30 * DAY;
  }).length;

  const semSinal = data.unidades.filter(
    (u) => !u.dhSinalVida || now - u.dhSinalVida.getTime() > DAY
  ).length;

  return (
    `RESUMO DO ESTADO ATUAL:\n` +
    `- Alarmes ativos: ${ativos.length}\n` +
    `- Alarmes graves (Alta/Crítica): ${criticos}\n` +
    `- Unidades cadastradas: ${data.unidades.length}\n` +
    `- Contratos a vencer em 30 dias: ${contratos30}\n` +
    `- Unidades sem sinal de vida há +24h: ${semSinal}\n` +
    `- Top lojas por volume de alarmes: ${top || "nenhuma"}`
  );
}

/* ============ chunking ============ */
function buildChunks(data) {
  const chunks = [];
  let i = 0;
  for (const a of data.alarmes) {
    const loja = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
    const grupo = [a.grupoNm, a.subgrupoNm].filter(Boolean).join(" / ") || "—";
    const venc = a.loja_dtValContrato
      ? a.loja_dtValContrato.toLocaleDateString("pt-BR")
      : "—";
    chunks.push({
      id: `al-${i++}`,
      type: "alarme",
      text:
        `Loja ${loja} (${a.contaNm || "—"}): ${a.alarmeDesc || "alarme"} no ` +
        `${a.dispositivoNm || "dispositivo"} [${grupo}], criticidade ${a.criticidade || "—"}, ` +
        `aberto há ${a.tempo || "—"}. Contrato ${a.loja_contrato || "—"} vence ${venc}.`,
    });
  }
  for (const u of data.unidades) {
    const loja = u.lojaApelido || u.lojaNm || `loja#${u.lojaId}`;
    const venc = u.dtValContrato ? u.dtValContrato.toLocaleDateString("pt-BR") : "—";
    const sinal = u.dhSinalVida ? u.dhSinalVida.toLocaleString("pt-BR") : "sem registro";
    chunks.push({
      id: `un-${i++}`,
      type: "unidade",
      text:
        `Unidade ${loja} (${u.contaNm || "—"}): contrato ${u.tpContratoNm || "—"}, ` +
        `vence ${venc}, último sinal de vida ${sinal}.`,
    });
  }
  return chunks;
}

/* ============ retrieval TF-IDF ============ */
const STOP = new Set([
  "a","o","os","as","um","uma","de","do","da","dos","das","em","no","na","nos","nas",
  "para","por","com","sem","que","qual","quais","quem","como","onde","quando","quanto",
  "quantos","quantas","e","ou","ao","aos","mais","menos","tem","ha","sao","esta","estao",
]);

function tokenize(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

function retrieve(question, chunks, k) {
  const docs = chunks.map((c) => tokenize(c.text));
  const N = docs.length || 1;
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const vec = (tokens) => {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const len = tokens.length || 1;
    const v = new Map();
    for (const [t, c] of tf) v.set(t, (c / len) * idf(t));
    return v;
  };
  const norm = (v) => {
    let s = 0;
    for (const w of v.values()) s += w * w;
    return Math.sqrt(s) || 1;
  };

  const qv = vec(tokenize(question));
  const qn = norm(qv);

  return chunks
    .map((c, i) => {
      const dv = vec(docs[i]);
      const dn = norm(dv);
      let dot = 0;
      const [small, large] = qv.size < dv.size ? [qv, dv] : [dv, qv];
      for (const [t, w] of small) {
        const w2 = large.get(t);
        if (w2) dot += w * w2;
      }
      return { chunk: c, score: dot / (qn * dn) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/* ============ Gemini ============ */
async function callGemini(question, summary, retrieved) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return "O assistente de IA não está configurado no momento (falta a chave do Gemini).";
  }

  const chunkText = retrieved
    .map((r, i) => `[${i + 1}] ${r.chunk.text}`)
    .join("\n");

  const prompt = `Você é o assistente de monitoramento Galileo Watch (refrigeração comercial da EletroFrio), respondendo por WhatsApp.
Responda usando o RESUMO e os TRECHOS abaixo. Não invente dados que não estejam ali.
Seja MUITO conciso (é mensagem de celular): no máximo 4 frases curtas. Use no máximo 1 emoji se fizer sentido.
Responda em português do Brasil.

${summary}

TRECHOS RELEVANTES:
${chunkText || "(nenhum trecho específico encontrado)"}

PERGUNTA: ${question}

RESPOSTA:`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 400, topP: 0.95 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[whatsapp] gemini err", res.status, await res.text().catch(() => ""));
      return "Não consegui gerar a resposta agora. Tente novamente em instantes.";
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("").trim();
    return text || "Sem resposta do modelo.";
  } finally {
    clearTimeout(timeout);
  }
}

/* ============ resposta TwiML ============ */
function twiml(message) {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Message>${escapeXml(message)}</Message></Response>`;
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
    body: xml,
  };
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
