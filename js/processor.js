/* processor.js
 * --------------------------------------------------------------
 * Implementa o estágio "Tratamento" do fluxo informacional:
 *
 *   1. Normalização: trim em strings, parse de datas, coerção de tipos,
 *      tratamento dos nulos críticos. Resolve casos como "Afonso Pena "
 *      com espaço sobrando (apontado nas análises prévias).
 *
 *   2. Enriquecimento: faz o "join" alarmes × unidades por lojaId/contaId,
 *      anexando ao alarme o cadastro da loja (contrato, dhSinalVida, etc).
 *
 *   3. Validação: dedupe por alarmeId e descarte dos últimos N valores
 *      em séries de telemetria (orientação explícita do apresentador).
 *
 * ATENÇÃO: como o JSON real pode trazer nomes em variações (camelCase,
 * snake_case, com/sem acento, em PT ou EN), usamos `pick()` que procura
 * por uma lista de candidatos com matching case-insensitive.
 * --------------------------------------------------------------
 */
window.GalileoProcessor = (function (cfg) {
  /* ----------------- helpers básicos ----------------- */
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
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const s = String(v).replace(" ", "T");
    const d = new Date(s);
    if (isNaN(d.getTime())) {
      // tentar formato brasileiro dd/mm/yyyy [hh:mm[:ss]]
      const m = String(v).match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
      );
      if (m) {
        const [, dd, mm, yyyy, hh, mi, ss] = m;
        return new Date(
          Number(yyyy),
          Number(mm) - 1,
          Number(dd),
          Number(hh || 0),
          Number(mi || 0),
          Number(ss || 0)
        );
      }
      return null;
    }
    return d;
  }

  function toNumberOrNull(v) {
    if (v === null || v === undefined || v === "") return null;
    // aceita "23,5" (vírgula como decimal)
    const s = typeof v === "string" ? v.replace(",", ".") : v;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function toBoolean(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["true", "1", "s", "sim", "y", "yes", "on", "ativo"].includes(s)) return true;
      if (["false", "0", "n", "nao", "não", "no", "off", "inativo"].includes(s)) return false;
    }
    return null;
  }

  /* pick: procura no objeto raw por uma chave que case (case-insensitive)
   * com qualquer dos nomes candidatos. Retorna o valor encontrado ou undefined. */
  function pick(raw, candidates) {
    if (!raw || typeof raw !== "object") return undefined;
    const keys = Object.keys(raw);
    const lowerMap = {};
    for (const k of keys) lowerMap[k.toLowerCase()] = k;
    for (const c of candidates) {
      const real = lowerMap[c.toLowerCase()];
      if (real !== undefined) return raw[real];
    }
    return undefined;
  }

  /* ----------------- normalizadores ------------------ */
  function normalizeAlarme(raw) {
    const ativoRaw = pick(raw, ["ativo", "active", "isActive", "status", "situacao", "situação"]);
    const ativoBool = toBoolean(ativoRaw);

    // Se não há campo "ativo" detectável, assumimos true: a API documentada
    // só devolve alarmes ativos ou recentes — descartar tudo seria pior do
    // que mostrar tudo. O usuário pode filtrar depois.
    const ativo = ativoBool === null ? true : ativoBool;

    return {
      // identificação
      alarmeId: clean(pick(raw, ["alarmeId", "idAlarme", "alarme_id", "id"])),
      contaId: clean(pick(raw, ["contaId", "idConta", "conta_id"])),
      contaNm: clean(pick(raw, ["contaNm", "contaNome", "conta", "contaName"])),
      lojaId: clean(pick(raw, ["lojaId", "idLoja", "loja_id"])),
      lojaNm: clean(pick(raw, ["lojaNm", "lojaNome", "loja", "lojaName"])),
      lojaApelido: clean(pick(raw, ["lojaApelido", "apelido", "lojaAlias"])),
      dispositivoId: clean(pick(raw, ["dispositivoId", "idDispositivo", "dispositivo_id"])),
      dispositivoNm: clean(pick(raw, ["dispositivoNm", "dispositivoNome", "dispositivo", "deviceName"])),
      tpContratoId: clean(pick(raw, ["tpContratoId", "idTpContrato", "tipoContratoId"])),
      tpContratoNm: clean(pick(raw, ["tpContratoNm", "tipoContrato", "contratoTipo", "tpContrato"])),
      nrPedido: clean(pick(raw, ["nrPedido", "numeroPedido", "pedido"])),

      // status
      ativo,
      criticidade: normalizeCriticidade(
        pick(raw, ["criticidade", "severidade", "severity", "prioridade", "priority", "nivel"])
      ),
      ppAbertura: clean(pick(raw, ["ppAbertura", "abertura", "ppOpening"])),
      grupoNm: clean(pick(raw, ["grupoNm", "grupo", "grupoNome"])),
      subgrupoNm: clean(pick(raw, ["subgrupoNm", "subgrupo", "subgrupoNome"])),
      apiTipo: clean(pick(raw, ["apiTipo", "tipoApi", "apiType"])),
      requerTecnico: toBoolean(pick(raw, ["requerTecnico", "requerTec", "needsTechnician"])) || false,

      // tratamento
      alarmeDhCad: toDate(pick(raw, ["alarmeDhCad", "dhCad", "dataAbertura", "dh", "criado", "createdAt"])),
      alarmeDesc: clean(pick(raw, ["alarmeDesc", "descricao", "descrição", "desc", "description"])),
      silenciarAte: toDate(pick(raw, ["silenciarAte", "silenciadoAte", "muteUntil"])),
      eventoDhCad: toDate(pick(raw, ["eventoDhCad", "eventoDh", "eventoData"])),
      eventoDesc: clean(pick(raw, ["eventoDesc", "eventoDescricao", "evento"])),
      eventoUsu: clean(pick(raw, ["eventoUsu", "eventoUsuario", "eventoUser"])),
      tempo: clean(pick(raw, ["tempo", "elapsed", "duracao"])),
      motivoIA: clean(pick(raw, ["motivoIA", "iaMotivo", "aiReason"])),

      _raw: raw,
    };
  }

  function normalizeCriticidade(v) {
    if (!v && v !== 0) return null;
    const s = String(v).trim().toLowerCase();
    if (!s) return null;
    // Códigos da API do Galileo (descobertos via debug.html):
    //   C = Crítica   (máxima severidade)
    //   A = Alta
    //   M = Média
    //   B = Baixa
    //   I = Informativa
    if (s === "c" || s.startsWith("crit")) return "Crítica";
    if (s === "a" || s.startsWith("alta") || s === "high" || s === "3" || s === "h") return "Alta";
    if (s === "m" || s.startsWith("med") || s === "media" || s === "média" || s === "medium" || s === "2") return "Média";
    if (s === "b" || s.startsWith("baixa") || s === "low" || s === "1" || s === "l") return "Baixa";
    if (s === "i" || s.startsWith("inf")) return "Informativa";
    // fallback: capitaliza
    return String(v).trim().charAt(0).toUpperCase() + String(v).trim().slice(1).toLowerCase();
  }

  function normalizeUnidade(raw) {
    return {
      contaId: clean(pick(raw, ["contaId", "idConta", "conta_id"])),
      contaNm: clean(pick(raw, ["contaNm", "contaNome", "conta"])),
      lojaId: clean(pick(raw, ["lojaId", "idLoja", "loja_id"])),
      lojaNm: clean(pick(raw, ["lojaNm", "lojaNome", "loja"])),
      lojaApelido: clean(pick(raw, ["lojaApelido", "apelido"])),
      tpContratoId: clean(pick(raw, ["tpContratoId", "idTpContrato"])),
      tpContratoNm: clean(pick(raw, ["tpContratoNm", "tipoContrato", "contratoTipo"])),
      nrPedido: clean(pick(raw, ["nrPedido", "numeroPedido", "pedido"])),
      dtValContrato: toDate(pick(raw, ["dtValContrato", "dataValidadeContrato", "vencimento", "dtVencimento"])),
      dhSinalVida: toDate(pick(raw, ["dhSinalVida", "sinalVida", "lastSeen", "ultimaComunicacao"])),
      telefone: clean(pick(raw, ["telefone", "fone", "phone"])),
      cnpj: clean(pick(raw, ["cnpj", "CNPJ", "documento"])),
      endereco: clean(pick(raw, ["endereco", "endereço", "address"])),
      _raw: raw,
    };
  }

  function normalizeTelemetriaPoint(raw) {
    const ts = toDate(
      pick(raw, [
        "dhLeitura", "dhCad", "dh", "data", "dataHora", "dataLeitura",
        "timestamp", "ts", "tempo", "horario", "datahora",
      ])
    );

    const valor = toNumberOrNull(
      pick(raw, [
        "valor", "temperatura", "temp", "leitura", "value", "v",
        "medicao", "medição", "reading",
      ])
    );

    return {
      ts,
      valor,
      sensor: clean(
        pick(raw, ["sensorNm", "sensor", "grupoNm", "sensorName", "canal", "ponto"])
      ),
      _raw: raw,
    };
  }

  /* ----------------- pipeline ----------------- */
  function processAlarmes(rawArr) {
    if (!Array.isArray(rawArr)) return [];
    const seen = new Set();
    const out = [];
    for (const r of rawArr) {
      const a = normalizeAlarme(r);
      const key = a.alarmeId || JSON.stringify([a.dispositivoId, a.alarmeDhCad]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
    if (rawArr.length > 0 && out.length === 0) {
      console.warn("[processor] alarmes: 0 tratados de", rawArr.length, "brutos");
      console.warn("[processor] chaves do 1º alarme bruto:", Object.keys(rawArr[0]));
    }
    return out;
  }

  function processUnidades(rawArr) {
    if (!Array.isArray(rawArr)) return [];
    const seen = new Set();
    const out = [];
    for (const r of rawArr) {
      const u = normalizeUnidade(r);
      const key = `${u.lojaId}__${u.contaId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
    return out;
  }

  /* ----------------- telemetria ----------------- *
   * Suporta dois formatos:
   *
   *   (a) Formato Chart.js (real do Galileo):
   *       { labels: ["18:40", "18:45", ...],
   *         datasets: [
   *           { label: "Temperatura Ambiente", color: "#0016ff", values: [2.2, 2.8, ...] },
   *           { label: "Setpoint Ambiente", ..., values: [1, 1, 1, ...] },
   *           ...
   *         ] }
   *       Os últimos N valores costumam vir como `null` — descartamos.
   *
   *   (b) Formato array de pontos (fallback, caso a API mude):
   *       [{ ts, valor, sensor }, ...]
   *
   * Retorna sempre:
   *   {
   *     principal: [{ts, tsLabel, valor, sensor}, ...]   // série de temperatura
   *     series:    [{label, color, points: [...]}]       // todas as séries
   *   }
   */
  function processTelemetria(raw) {
    // formato Chart.js
    if (
      raw &&
      typeof raw === "object" &&
      Array.isArray(raw.labels) &&
      Array.isArray(raw.datasets)
    ) {
      return processChartJsTelemetria(raw);
    }

    // fallback: formato antigo (array de pontos)
    if (Array.isArray(raw)) {
      const dropN = cfg.telemetria.dropLastN || 0;
      const sliced = dropN > 0 ? raw.slice(0, Math.max(0, raw.length - dropN)) : raw;
      const pts = sliced.map(normalizeTelemetriaPoint).filter((p) => p.ts && p.valor !== null);
      return {
        principal: pts,
        series: pts.length
          ? [{ label: pts[0].sensor || "leitura", color: null, points: pts }]
          : [],
      };
    }

    console.warn("[processor] telemetria: formato não reconhecido", raw);
    return { principal: [], series: [] };
  }

  function processChartJsTelemetria(raw) {
    const labels = raw.labels.slice();
    const datasets = raw.datasets || [];

    // Descarta os últimos N labels/values. O apresentador disse 5, mas
    // observei até 8 nulos no fim — descartamos o que for maior entre
    // a config (5) e a contagem real de nulos no fim do 1º dataset.
    const dropConfig = cfg.telemetria.dropLastN || 0;
    let dropReal = 0;
    if (datasets[0] && Array.isArray(datasets[0].values)) {
      const v = datasets[0].values;
      for (let i = v.length - 1; i >= 0; i--) {
        if (v[i] === null || v[i] === undefined) dropReal++;
        else break;
      }
    }
    const drop = Math.max(dropConfig, dropReal);
    const useUntil = Math.max(0, labels.length - drop);
    const usedLabels = labels.slice(0, useUntil);

    const series = datasets.map((ds) => {
      const values = (ds.values || []).slice(0, useUntil);
      const points = [];
      for (let i = 0; i < usedLabels.length; i++) {
        const v = values[i];
        if (v === null || v === undefined) continue;
        points.push({
          ts: parseLabelTime(usedLabels[i]),
          tsLabel: String(usedLabels[i]),
          valor: Number(v),
          sensor: clean(ds.label),
        });
      }
      return {
        label: clean(ds.label) || "série",
        color: clean(ds.color) || null,
        points,
      };
    });

    // Série principal: prefere "Temperatura Ambiente"; senão a primeira
    // que tenha "temperatura" no nome; senão a primeira do array.
    const tempIdx = series.findIndex((s) => /temperatura\s+ambiente/i.test(s.label));
    const fallbackIdx = series.findIndex((s) => /temperatura/i.test(s.label));
    const principalIdx = tempIdx >= 0 ? tempIdx : fallbackIdx >= 0 ? fallbackIdx : 0;
    const principal = series[principalIdx] ? series[principalIdx].points : [];

    return { principal, series };
  }

  /* Converte um label "HH:MM" num Date de hoje com aquela hora.
   * Como os labels da API são só HH:MM (sem data), assumimos que a
   * série representa as últimas ~24h e o último label é "agora-ish". */
  function parseLabelTime(label) {
    if (!label || typeof label !== "string") return new Date();
    const m = label.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return new Date();
    const d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }

  /* ----------------- enriquecimento ----------------- */
  function indexUnidades(unidades) {
    const byLojaId = new Map();
    for (const u of unidades) {
      if (u.lojaId) byLojaId.set(String(u.lojaId), u);
    }
    return byLojaId;
  }

  function enrichAlarmes(alarmes, unidadesIndex) {
    return alarmes.map((a) => {
      const u = a.lojaId ? unidadesIndex.get(String(a.lojaId)) : null;
      return {
        ...a,
        loja_contrato: u?.tpContratoNm || a.tpContratoNm || null,
        loja_dtValContrato: u?.dtValContrato || null,
        loja_dhSinalVida: u?.dhSinalVida || null,
        loja_endereco: u?.endereco || null,
        loja_telefone: u?.telefone || null,
      };
    });
  }

  /* ----------------- orquestração ----------------- */
  function process({ alarmesRaw, unidadesRaw, telemetriaRaw }) {
    const alarmes = processAlarmes(alarmesRaw);
    const unidades = processUnidades(unidadesRaw);
    const tel = processTelemetria(telemetriaRaw);

    const uIdx = indexUnidades(unidades);
    const alarmesEnriched = enrichAlarmes(alarmes, uIdx);

    return {
      alarmes: alarmesEnriched,
      unidades,
      telemetria: tel.principal,      // série principal (Temperatura Ambiente) — usada por stats e RAG
      telemetriaSeries: tel.series,   // todas as séries — usado pra plotar múltiplas linhas
      meta: {
        nAlarmesBrutos: Array.isArray(alarmesRaw) ? alarmesRaw.length : 0,
        nAlarmesTratados: alarmesEnriched.length,
        nUnidadesBrutas: Array.isArray(unidadesRaw) ? unidadesRaw.length : 0,
        nUnidadesTratadas: unidades.length,
        nTelemetriaBrutas: Array.isArray(telemetriaRaw)
          ? telemetriaRaw.length
          : telemetriaRaw && telemetriaRaw.labels
          ? telemetriaRaw.labels.length
          : 0,
        nTelemetriaTratadas: tel.principal.length,
        nTelemetriaSeries: tel.series.length,
        processedAt: new Date(),
      },
    };
  }

  return {
    process,
    _normalizeAlarme: normalizeAlarme,
    _normalizeUnidade: normalizeUnidade,
    _normalizeTelemetriaPoint: normalizeTelemetriaPoint,
    _pick: pick,
  };
})(window.GALILEO_CONFIG);
