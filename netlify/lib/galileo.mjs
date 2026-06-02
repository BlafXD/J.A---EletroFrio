/* netlify/lib/galileo.mjs
 * --------------------------------------------------------------
 * Módulo compartilhado pelas functions (monitor, webhook, teste).
 * Fica FORA de netlify/functions/, então o Netlify não o expõe como
 * endpoint; o esbuild o inclui no bundle ao seguir os imports.
 *
 * Centraliza: coleta dos endpoints, normalização, análise de
 * telemetria, chamadas ao Gemini e envio via Twilio.
 * --------------------------------------------------------------
 */

export const GALILEO_BASE =
  "https://credenciamento.eletrofrio.com.br:5900/galileo/api/api_hackathon";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/* ===================== coleta ===================== */
export async function fetchAlarmes() {
  const r = await fetch(`${GALILEO_BASE}?route=alarmes`, { headers: { Accept: "application/json" } });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
export async function fetchUnidades() {
  const r = await fetch(`${GALILEO_BASE}?route=unidades`, { headers: { Accept: "application/json" } });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
export async function fetchTelemetria(dispositivoId) {
  const r = await fetch(`${GALILEO_BASE}?route=telemetria&dispositivoId=${encodeURIComponent(dispositivoId)}`, {
    headers: { Accept: "application/json" },
  });
  return await r.json();
}

/* ===================== helpers ===================== */
export function clean(v) {
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
export function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
export function normNumero(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

/* ===================== processamento (alarmes × unidades) ===================== */
export function processData(alarmesRaw, unidadesRaw) {
  const unidades = (unidadesRaw || []).map((u) => ({
    lojaId: clean(u.lojaId),
    lojaNm: clean(u.lojaNm),
    lojaApelido: clean(u.lojaApelido),
    contaNm: clean(u.contaNm),
    tpContratoNm: clean(u.tpContratoNm),
    dtValContrato: toDate(u.dtValContrato),
    dhSinalVida: toDate(u.dhSinalVida),
    telefone: clean(u.telefone),
  }));
  const uIdx = new Map();
  for (const u of unidades) if (u.lojaId != null) uIdx.set(String(u.lojaId), u);

  const alarmes = (alarmesRaw || []).map((a) => {
    const u = a.lojaId != null ? uIdx.get(String(a.lojaId)) : null;
    return {
      alarmeId: clean(a.alarmeId),
      lojaId: clean(a.lojaId),
      lojaNm: clean(a.lojaNm),
      lojaApelido: clean(a.lojaApelido),
      contaNm: clean(a.contaNm),
      dispositivoId: clean(a.dispositivoId),
      dispositivoNm: clean(a.dispositivoNm),
      grupoNm: clean(a.grupoNm),
      subgrupoNm: clean(a.subgrupoNm),
      alarmeDesc: clean(a.alarmeDesc),
      criticidade: normCrit(a.criticidade),
      tempo: clean(a.tempo),
      loja_contrato: u?.tpContratoNm || null,
      loja_dtValContrato: u?.dtValContrato || null,
      loja_dhSinalVida: u?.dhSinalVida || null,
      loja_telefone: u?.telefone || null,
    };
  });
  return { alarmes, unidades };
}

/* ===================== análise de telemetria ===================== */
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function media(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function ultimoValido(vals) {
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i;
  return -1;
}

export function analisarTelemetria(tel) {
  if (!tel || !Array.isArray(tel.datasets)) return null;
  const labels = Array.isArray(tel.labels) ? tel.labels : [];

  const series = tel.datasets.map((ds) => {
    const vals = (ds.values || []).map(num);
    const validos = vals.filter((v) => v !== null);
    const idx = ultimoValido(vals);
    const atual = idx >= 0 ? vals[idx] : null;
    const horaAtual = idx >= 0 && labels[idx] ? labels[idx] : null;
    const min = validos.length ? Math.min(...validos) : null;
    const max = validos.length ? Math.max(...validos) : null;
    const med = media(validos);
    const ult = validos.slice(-6);
    const ant = validos.slice(-12, -6);
    let tendencia = "estável";
    if (ult.length >= 3 && ant.length >= 3) {
      const diff = media(ult) - media(ant);
      if (diff > 0.5) tendencia = "subindo";
      else if (diff < -0.5) tendencia = "descendo";
    }
    return {
      label: ds.label, atual, horaAtual, min, max,
      media: med !== null ? +med.toFixed(1) : null,
      tendencia, amplitude: min !== null && max !== null ? +(max - min).toFixed(1) : null,
      n: validos.length,
    };
  });

  const temp =
    series.find((s) => /temperatura\s*ambiente/i.test(s.label)) ||
    series.find((s) => /temperatura/i.test(s.label) && !/degelo|sucção|evapora/i.test(s.label));
  const setpoint = series.find((s) => /setpoint/i.test(s.label));

  let desvioAtual = null, acimaSetpoint = null, minutosAcima = null;
  if (temp && setpoint && temp.atual !== null && setpoint.atual !== null) {
    desvioAtual = +(temp.atual - setpoint.atual).toFixed(1);
    acimaSetpoint = desvioAtual > 0.5;
  }
  if (temp && setpoint) {
    const tv = (tel.datasets.find((d) => d.label === temp.label)?.values || []).map(num);
    const sv = (tel.datasets.find((d) => d.label === setpoint.label)?.values || []).map(num);
    let cont = 0;
    for (let i = tv.length - 1; i >= 0; i--) {
      if (tv[i] === null) continue;
      const sp = sv[i] !== null ? sv[i] : setpoint.atual;
      if (sp !== null && tv[i] - sp > 0.5) cont++;
      else break;
    }
    if (cont > 0) minutosAcima = cont * 5;
  }
  return { series, temp, setpoint, desvioAtual, acimaSetpoint, minutosAcima, totalPontos: labels.length };
}

export function resumirTelemetria(a) {
  if (!a) return "Telemetria indisponível para este dispositivo.";
  const linhas = a.series.map((s) => {
    if (s.atual === null) return `- ${s.label}: sem leitura recente`;
    return `- ${s.label}: atual ${s.atual}${s.horaAtual ? ` às ${s.horaAtual}` : ""}, variou de ${s.min} a ${s.max} (média ${s.media}), tendência ${s.tendencia}`;
  });
  let cab = "";
  if (a.desvioAtual !== null) {
    if (a.acimaSetpoint) {
      cab = `Temperatura atual ${Math.abs(a.desvioAtual)}°C ACIMA do setpoint`;
      if (a.minutosAcima) cab += ` (acima há ~${a.minutosAcima} min)`;
      cab += ".\n";
    } else {
      cab = `Temperatura dentro/abaixo do setpoint (desvio ${a.desvioAtual}°C).\n`;
    }
  }
  return cab + linhas.join("\n");
}

/* ===================== Gemini ===================== */
export async function callGemini(prompt, maxTokens = 500) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: maxTokens, topP: 0.95 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error("[gemini] erro", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const txt = parts.map((p) => p.text || "").join("").trim();
    return txt || null;
  } catch (e) {
    console.error("[gemini] falha:", e.message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Diagnóstico técnico de um alarme com base na telemetria do dispositivo
export async function gerarDiagnostico(alarme, resumoTelemetria) {
  const loja = alarme.lojaApelido || alarme.lojaNm || `loja#${alarme.lojaId}`;
  const prompt = `Você é um técnico especialista em refrigeração comercial. Analise o alarme e a telemetria do equipamento e produza um diagnóstico CONCISO para enviar por WhatsApp ao responsável da loja.

ALARME:
- Loja: ${loja}
- Dispositivo: ${alarme.dispositivoNm || "—"}
- Tipo: ${alarme.alarmeDesc || "—"}
- Grupo: ${[alarme.grupoNm, alarme.subgrupoNm].filter(Boolean).join(" / ") || "—"}
- Criticidade: ${alarme.criticidade || "—"}
- Aberto há: ${alarme.tempo || "—"}

TELEMETRIA (leituras recentes do equipamento):
${resumoTelemetria}

Responda em português do Brasil, no máximo 5 frases curtas, cobrindo:
1) o que provavelmente está acontecendo;
2) causa(s) provável(is);
3) ação recomendada.
Use os números da telemetria. NÃO invente dados que não estão acima. Tom técnico mas claro. Sem saudações.`;
  const r = await callGemini(prompt, 500);
  return r;
}

// Resposta do chatbot a uma pergunta do responsável, no contexto do alarme
export async function responderPergunta(pergunta, contexto, resumoTelemetriaAtual) {
  const prompt = `Você é o assistente do sistema de monitoramento Galileo Watch, conversando por WhatsApp com o responsável pela loja "${contexto.lojaNm || "—"}".

CONTEXTO — alarme mais recente desta loja:
- Dispositivo: ${contexto.dispositivoNm || "—"}
- Alarme: ${contexto.alarmeDesc || "—"} (criticidade ${contexto.criticidade || "—"}, aberto há ${contexto.tempo || "—"})
- Diagnóstico já enviado: ${contexto.diagnostico || "—"}

TELEMETRIA ATUAL do equipamento:
${resumoTelemetriaAtual || contexto.resumoTelemetria || "indisponível"}

O responsável perguntou: "${pergunta}"

Responda em português do Brasil, de forma clara e útil, no máximo 4 frases curtas. Baseie-se no contexto e na telemetria. Se a pergunta fugir do tema, responda com o que for possível a partir dos dados. Não invente. Sem saudações longas.`;
  const r = await callGemini(prompt, 400);
  return r;
}

/* ===================== mensagem ===================== */
export function buildAlertHeader(a, { teste = false } = {}) {
  const loja = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
  const grupo = [a.grupoNm, a.subgrupoNm].filter(Boolean).join(" / ") || "—";
  let contrato = "";
  if (a.loja_contrato) {
    contrato = `\n📋 Contrato: ${a.loja_contrato}`;
    if (a.loja_dtValContrato) {
      const dias = Math.round((a.loja_dtValContrato.getTime() - Date.now()) / 86400000);
      if (dias >= 0 && dias <= 60) contrato += ` (vence em ${dias} dias)`;
    }
  }
  const prefixo = teste ? "[TESTE] " : "";
  return (
    `🚨 *${prefixo}ALARME ${a.criticidade ? a.criticidade.toUpperCase() : ""}* — ${loja}\n` +
    `📍 ${a.dispositivoNm || "—"}\n` +
    `🔧 ${a.alarmeDesc || "—"}\n` +
    `📂 ${grupo} · ⏱️ há ${a.tempo || "—"}` +
    contrato
  );
}

/* ===================== Twilio ===================== */
export async function sendWhatsApp({ sid, token, from, to, body }) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const form = new URLSearchParams({ From: from, To: to, Body: body });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[twilio] erro", res.status, data);
      return { ok: false, status: res.status, twilio: data };
    }
    return { ok: true, status: data.status, sid: data.sid, twilio: data };
  } catch (e) {
    console.error("[twilio] falha:", e.message);
    return { ok: false, twilio: { message: e.message } };
  }
}
