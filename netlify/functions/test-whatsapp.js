/* netlify/functions/test-whatsapp.js
 * --------------------------------------------------------------
 * Endpoint de TESTE/DEMONSTRAÇÃO.
 *
 * Acesse https://SEU-SITE/api/test-whatsapp no navegador para disparar
 * UMA notificação de exemplo no WhatsApp — usando o alarme crítico mais
 * recente real do sistema. Ignora o dedupe e o bootstrap (que existem
 * só no monitor agendado), então SEMPRE envia.
 *
 * Útil para:
 *   - validar a integração Twilio sem esperar o cron de 5 min
 *   - demonstrar a notificação ao vivo numa apresentação
 *
 * Usa as mesmas variáveis de ambiente do monitor:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM,
 *   ALERT_WHATSAPP_TO
 * --------------------------------------------------------------
 */

const GALILEO_BASE =
  "https://credenciamento.eletrofrio.com.br:5900/galileo/api/api_hackathon";

exports.handler = async (event) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ALERT_WHATSAPP_TO;

  // ?modo=real → envia a mensagem idêntica à de produção (sem rótulo [TESTE])
  const modoReal = (event.queryStringParameters || {}).modo === "real";

  const faltando = [];
  if (!sid) faltando.push("TWILIO_ACCOUNT_SID");
  if (!token) faltando.push("TWILIO_AUTH_TOKEN");
  if (!from) faltando.push("TWILIO_WHATSAPP_FROM");
  if (!to) faltando.push("ALERT_WHATSAPP_TO");
  if (faltando.length) {
    return json(500, {
      ok: false,
      erro: "Variáveis de ambiente ausentes",
      faltando,
    });
  }

  try {
    const [alarmesRaw, unidadesRaw] = await Promise.all([
      fetch(`${GALILEO_BASE}?route=alarmes`, { headers: { Accept: "application/json" } }).then((r) => r.json()),
      fetch(`${GALILEO_BASE}?route=unidades`, { headers: { Accept: "application/json" } }).then((r) => r.json()),
    ]);

    const data = processData(
      Array.isArray(alarmesRaw) ? alarmesRaw : [],
      Array.isArray(unidadesRaw) ? unidadesRaw : []
    );
    const criticos = data.alarmes.filter(
      (a) => a.criticidade === "Crítica" || a.criticidade === "Alta"
    );

    if (!criticos.length) {
      return json(200, {
        ok: false,
        mensagem: "Nenhum alarme crítico ativo no momento para usar de exemplo.",
      });
    }

    const alarme = criticos[0];
    const body = buildAlertMessage(alarme, modoReal);
    const resultado = await sendWhatsApp({ sid, token, from, to, body });

    return json(resultado.ok ? 200 : 502, {
      ok: resultado.ok,
      mensagem: resultado.ok
        ? "Twilio ACEITOU a mensagem. Se não chegou no WhatsApp, veja 'twilio_status' abaixo " +
          "(provável janela de 24h do sandbox — mande qualquer mensagem ao número do sandbox e teste de novo)."
        : "Falha ao enviar — veja os detalhes em 'twilio' abaixo.",
      twilio_status: resultado.status || null,
      twilio_sid: resultado.sid || null,
      twilio_erro: resultado.twilio?.code
        ? `${resultado.twilio.code}: ${resultado.twilio.message || ""}`
        : null,
      preview: body,
      destino: to,
    });
  } catch (e) {
    return json(502, { ok: false, erro: e.message });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(obj, null, 2),
  };
}

/* ===== lógica compartilhada (igual ao alarmes-monitor) ===== */
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
function buildAlertMessage(a, modoReal = false) {
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

  // modoReal=true reproduz exatamente a mensagem de produção (sem [TESTE])
  const prefixo = modoReal ? "" : "[TESTE] ";
  const rodape = modoReal
    ? "Galileo Watch · monitoramento automático"
    : "Galileo Watch · mensagem de teste";

  return (
    `🚨 *${prefixo}ALARME ${a.criticidade ? a.criticidade.toUpperCase() : ""}* — ${loja}\n\n` +
    `📍 Dispositivo: ${a.dispositivoNm || "—"}\n` +
    `🔧 Tipo: ${a.alarmeDesc || "—"}\n` +
    `📂 Grupo: ${grupo}\n` +
    `⏱️ Aberto há: ${a.tempo || "—"}` +
    contratoLinha +
    sinalLinha +
    `\n\n⚠️ Risco de perda de produto perecível. Verificação recomendada.\n` +
    `_${rodape}_`
  );
}
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
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[test-whatsapp] twilio erro", res.status, data);
      return { ok: false, status: res.status, twilio: data };
    }
    // data.status costuma ser "queued" ou "accepted" — entrega acontece depois
    return { ok: true, status: data.status, sid: data.sid, twilio: data };
  } catch (e) {
    console.error("[test-whatsapp] falha:", e.message);
    return { ok: false, twilio: { message: e.message } };
  }
}
