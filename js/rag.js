/* rag.js
 * --------------------------------------------------------------
 * Motor de consulta inspirado em RAG, 100% client-side.
 *
 * Diferença em relação a um RAG "de verdade" (com embeddings densos
 * tipo OpenAI/Cohere/sentence-transformers): aqui usamos similaridade
 * léxica via TF-IDF cosseno entre a pergunta e os chunks. Isso é
 * computacionalmente barato, roda sem chave de API, e — para o
 * vocabulário restrito do domínio (loja, alarme, temperatura,
 * contrato, sinal de vida) — produz recuperação suficiente para a PoC.
 *
 * Para evoluir: trocar `embed()` por chamada a um endpoint de
 * embeddings (e.g. /api/embed) e armazenar vetores num índice
 * (pgvector, Pinecone, Chroma). A interface deste módulo permanece.
 *
 * O pipeline aqui é:
 *   buildChunks(data)  -> gera textos descritivos a partir dos dados tratados
 *   buildIndex(chunks) -> calcula TF-IDF de cada chunk
 *   answer(question)   -> recupera top-K chunks + sintetiza resposta
 *                         usando regras + dados estruturados
 * --------------------------------------------------------------
 */
window.GalileoRAG = (function (analytics) {
  /* ---------- tokenização básica ---------- */
  const STOPWORDS = new Set([
    "a","o","os","as","um","uma","de","do","da","dos","das","em","no","na","nos","nas",
    "para","por","com","sem","que","qual","quais","quem","como","onde","quando","quanto",
    "quantos","quantas","e","ou","ao","aos","à","às","mais","menos","muito","muitos",
    "está","estão","tem","têm","ter","há","são","foi","ser","essa","esse","isso","esta",
    "este","isto","aquela","aquele","aquilo","sobre","entre","mas","também","já",
  ]);

  function tokenize(text) {
    if (!text) return [];
    return String(text)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // remove acentos
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  }

  /* ---------- chunking ---------- */
  // Cada chunk é uma frase descritiva sobre uma entidade do domínio.
  // O ID do chunk e o tipo permitem rastrear a fonte na resposta.
  function buildChunks(data) {
    const chunks = [];
    let cid = 0;
    const now = new Date();

    // chunks de alarmes ativos
    for (const a of data.alarmes) {
      if (!a.ativo) continue;
      const loja = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
      const conta = a.contaNm || "—";
      const disp = a.dispositivoNm || `dispositivo#${a.dispositivoId}`;
      const crit = a.criticidade || "indefinida";
      const grupo = [a.grupoNm, a.subgrupoNm].filter(Boolean).join(" / ") || "sem grupo";
      const tempo = analytics.formatTempoAberto(a.alarmeDhCad, now);
      const evento = a.eventoDesc || "sem registro de evento";

      const text =
        `Loja ${loja} (${conta}): alarme "${a.alarmeDesc || "sem descrição"}" no ` +
        `${disp} — ${grupo}, criticidade ${crit}, aberto há ${tempo}. Evento: ${evento}. ` +
        `Contrato: ${a.loja_contrato || a.tpContratoNm || "—"}.`;

      chunks.push({
        id: `alarme-${cid++}`,
        type: "alarme",
        text,
        ref: a,
      });
    }

    // chunks de unidades — útil pra perguntas de contrato e sinal de vida
    for (const u of data.unidades) {
      const loja = u.lojaApelido || u.lojaNm || `loja#${u.lojaId}`;
      const sinal = u.dhSinalVida
        ? u.dhSinalVida.toLocaleString("pt-BR")
        : "sem registro";
      const venc = u.dtValContrato
        ? u.dtValContrato.toLocaleDateString("pt-BR")
        : "não informado";
      const text =
        `Unidade ${loja} (${u.contaNm || "—"}): contrato ${u.tpContratoNm || "—"}, ` +
        `vencimento ${venc}, último sinal de vida em ${sinal}, ` +
        `endereço ${u.endereco || "—"}.`;
      chunks.push({
        id: `unidade-${cid++}`,
        type: "unidade",
        text,
        ref: u,
      });
    }

    // chunk agregado de telemetria
    if (data.telemetria && data.telemetria.length) {
      const stats = analytics.statsTelemetria(data.telemetria);
      if (stats) {
        const text =
          `Telemetria do dispositivo ${data.telemetriaDispositivoId || ""}: ` +
          `${stats.n} leituras, média ${stats.avg}, mínimo ${stats.min}, máximo ${stats.max}. ` +
          `Última leitura: ${stats.ultima.valor} em ${stats.ultima.ts.toLocaleString("pt-BR")}.`;
        chunks.push({
          id: `telemetria-${cid++}`,
          type: "telemetria",
          text,
          ref: { stats, serie: data.telemetria },
        });
      }
    }

    return chunks;
  }

  /* ---------- índice TF-IDF ---------- */
  function buildIndex(chunks) {
    const docs = chunks.map((c) => tokenize(c.text));
    const N = docs.length;

    // DF: em quantos docs cada termo aparece
    const df = new Map();
    for (const d of docs) {
      const seen = new Set();
      for (const t of d) {
        if (seen.has(t)) continue;
        seen.add(t);
        df.set(t, (df.get(t) || 0) + 1);
      }
    }

    // TF-IDF por doc
    const vectors = docs.map((d) => {
      const tf = new Map();
      for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
      const len = d.length || 1;
      const vec = new Map();
      for (const [t, c] of tf.entries()) {
        const idf = Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;
        vec.set(t, (c / len) * idf);
      }
      return vec;
    });

    // norma para coseno
    const norms = vectors.map((v) => {
      let s = 0;
      for (const w of v.values()) s += w * w;
      return Math.sqrt(s) || 1;
    });

    return { chunks, vectors, norms, df, N };
  }

  function vectorize(query, index) {
    const tokens = tokenize(query);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const len = tokens.length || 1;
    const vec = new Map();
    for (const [t, c] of tf.entries()) {
      const idf = Math.log((index.N + 1) / ((index.df.get(t) || 0) + 1)) + 1;
      vec.set(t, (c / len) * idf);
    }
    return vec;
  }

  function cosineSim(a, b, normA, normB) {
    let dot = 0;
    const smaller = a.size < b.size ? a : b;
    const larger = smaller === a ? b : a;
    for (const [t, w] of smaller.entries()) {
      const w2 = larger.get(t);
      if (w2) dot += w * w2;
    }
    return dot / (normA * normB || 1);
  }

  function retrieve(query, index, k = 5) {
    const qvec = vectorize(query, index);
    let qnorm = 0;
    for (const w of qvec.values()) qnorm += w * w;
    qnorm = Math.sqrt(qnorm) || 1;

    const scored = index.chunks.map((c, i) => ({
      chunk: c,
      score: cosineSim(qvec, index.vectors[i], qnorm, index.norms[i]),
    }));

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /* ---------- camada factual (sem IA) ----------
   * Responde perguntas comuns DIRETO dos dados estruturados — sem gastar
   * quota do Gemini e sem risco de alucinação. Retorna { text } quando a
   * pergunta casa com uma intenção conhecida, ou null para deixar a IA
   * responder perguntas abertas.
   */
  // normaliza para casar intencao: minusculo + sem acento, MANTENDO stopwords
  // ("quantos", "qual" sao stopwords no tokenizer, mas importam aqui).
  function normIntent(text) {
    return String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  }

  function responderFactual(question, data) {
    const q = normIntent(question);
    if (!q) return null;
    const ativos = data.alarmes.filter((a) => a.ativo);
    const empresas = analytics.porEmpresa(data.alarmes, data.unidades);
    const isCrit = (a) => analytics.isCritico(a);

    // (0) saudacao / ajuda
    if (q.split(" ").length <= 5 &&
        /\b(oi|ola|opa|eai|salve|bom dia|boa tarde|boa noite|ajuda|ajudar|menu|faz|fazer|consegue|funciona|funcionalidade)\b/.test(q)) {
      return { text:
        "Oi! Sou o assistente do Freezer Controle. Com base nos dados em tempo real, posso te dizer:\n\n" +
        "\u2022 Quantos alarmes ativos e quantos criticos\n" +
        "\u2022 Quais lojas ou empresas tem mais alarmes criticos\n" +
        "\u2022 A distribuicao de alarmes por criticidade\n" +
        "\u2022 Lojas sem sinal de vida\n" +
        "\u2022 Contratos a vencer\n" +
        "\u2022 Os alarmes de uma empresa ou loja especifica (e so citar o nome)\n\n" +
        "Manda a pergunta!" };
    }

    // (1) alarmes de uma EMPRESA ou LOJA especifica (busca por nome)
    if (/(alarme|critic|problema|status|situacao|esta|tem)/.test(q)) {
      const alvoEmp = empresas.find((e) => {
        const nome = normIntent(e.contaNm);
        return nome.length >= 4 && q.includes(nome);
      });
      if (alvoEmp) {
        return { text:
          `Empresa ${alvoEmp.contaNm}: ${alvoEmp.lojas.length} loja(s), ` +
          `${alvoEmp.alarmes} alarme(s) ativo(s), ${alvoEmp.criticos} critico(s).` +
          (alvoEmp.alarmes ? "\n\nAbra o painel da empresa para ver loja a loja." : " Tudo certo no momento.") };
      }
      const alvoLoja = data.unidades.filter((u) => u.lojaNm).find((u) => {
        const nome = normIntent(u.lojaNm);
        return nome.length >= 4 && q.includes(nome);
      });
      if (alvoLoja) {
        const doStore = ativos.filter((a) => String(a.lojaId) === String(alvoLoja.lojaId));
        const crit = doStore.filter(isCrit).length;
        if (!doStore.length) return { text: `A loja ${alvoLoja.lojaNm} nao tem alarmes ativos no momento.` };
        const lista = doStore.slice(0, 8).map((a) => `\u2022 [${a.criticidade}] ${a.alarmeDesc || a.grupoNm} \u2014 ${a.dispositivoNm || "\u2014"}`).join("\n");
        return { text: `Loja ${alvoLoja.lojaNm}: ${doStore.length} alarme(s) ativo(s), ${crit} critico(s).\n\n${lista}` };
      }
    }

    // (2) distribuicao por criticidade
    if (q.includes("distribui") || q.includes("por criticidade") || q.includes("cada criticidade") ||
        (q.includes("criticidade") && (q.includes("quant") || q.includes("por") || q.includes("cada")))) {
      const c = analytics.porCriticidade(ativos);
      const linhas = ["Critica", "Alta", "Media", "Baixa", "Informativa"]
        .map((n) => [n, c[n] !== undefined ? c[n] : (c[n.replace("Critica","Cr\u00edtica").replace("Media","M\u00e9dia")] || 0)]);
      const reais = { "Cr\u00edtica": c["Cr\u00edtica"] || 0, "Alta": c["Alta"] || 0, "M\u00e9dia": c["M\u00e9dia"] || 0, "Baixa": c["Baixa"] || 0, "Informativa": c["Informativa"] || 0 };
      const txt = Object.entries(reais).filter(([, v]) => v > 0).map(([n, v]) => `\u2022 ${n}: ${v}`).join("\n");
      return { text: `Distribuicao dos ${ativos.length} alarmes ativos por criticidade:\n\n${txt || "nenhum alarme ativo."}` };
    }

    // (3) ranking: lojas/empresas com mais alarmes (criticos)
    if ((q.includes("loja") || q.includes("unidade") || q.includes("empresa")) &&
        (q.includes("mais") || q.includes("rank") || q.includes("top") || q.includes("critic") || q.includes("grave") || q.includes("pior"))) {
      const porEmp = q.includes("empresa");
      const soCrit = q.includes("critic") || q.includes("grave") || q.includes("urgente");
      if (porEmp) {
        const ranked = [...empresas].sort((a, b) => (soCrit ? b.criticos - a.criticos : b.alarmes - a.alarmes))
          .filter((e) => (soCrit ? e.criticos : e.alarmes) > 0).slice(0, 6);
        if (!ranked.length) return { text: soCrit ? "Nenhuma empresa com alarmes criticos ativos." : "Nenhuma empresa com alarmes ativos." };
        const lista = ranked.map((e) => `\u2022 ${e.contaNm}: ${soCrit ? e.criticos + " critico(s)" : e.alarmes + " alarme(s) (" + e.criticos + " crit.)"}`).join("\n");
        return { text: `Empresas com mais alarmes ${soCrit ? "criticos " : ""}ativos:\n\n${lista}` };
      }
      const por = new Map();
      for (const a of ativos) {
        if (soCrit && !isCrit(a)) continue;
        const nome = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
        por.set(nome, (por.get(nome) || 0) + 1);
      }
      const top = [...por.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      if (!top.length) return { text: soCrit ? "Nenhuma loja com alarmes criticos ativos." : "Nenhuma loja com alarmes ativos." };
      const lista = top.map(([n, qt]) => `\u2022 ${n}: ${qt} alarme(s)${soCrit ? " critico(s)" : ""}`).join("\n");
      return { text: `Lojas com mais alarmes ${soCrit ? "criticos " : ""}ativos:\n\n${lista}` };
    }

    // (4) sem sinal de vida
    if (q.includes("sinal") && (q.includes("vida") || q.includes("offline") || q.includes("comunic") || q.includes("sem sinal"))) {
      const horas = q.includes("48") ? 48 : 24;
      const sem = analytics.semSinalVida(data.unidades, horas);
      if (!sem.length) return { text: `Todas as unidades tiveram sinal de vida nas ultimas ${horas}h.` };
      const lista = sem.slice(0, 10).map((u) => `\u2022 ${u.loja}: ${u.horas_sem_sinal === null ? "sem registro" : u.horas_sem_sinal + "h sem sinal"}`).join("\n");
      return { text: `Unidades sem sinal de vida ha mais de ${horas}h (${sem.length}):\n\n${lista}` };
    }

    // (5) contratos a vencer
    if (q.includes("contrato") || q.includes("vencimento") || q.includes("vencer") || q.includes("vence")) {
      const lista = analytics.contratosComMaisAlarmes(data.alarmes, data.unidades, 8);
      if (!lista.length) return { text: "Nenhum contrato a vencer nos proximos 60 dias." };
      const linhas = lista.map((l) => `\u2022 ${l.loja} \u2014 vence em ${l.vence_em_dias}d${l.alarmes_ativos ? `, ${l.alarmes_ativos} alarme(s) ativo(s)` : ""}`).join("\n");
      return { text: `Contratos a vencer nos proximos 60 dias (${lista.length}):\n\n${linhas}` };
    }

    // (6) telemetria / temperatura
    if (q.includes("temperatura") || q.includes("telemetria")) {
      const stats = analytics.statsTelemetria(data.telemetria);
      if (!stats) return { text: "Nao ha leituras de telemetria carregadas aqui. Abra o painel de uma loja para ver a telemetria por equipamento." };
      return { text:
        `Telemetria do dispositivo monitorado (${stats.n} leituras validas):\n\n` +
        `\u2022 Media: ${stats.avg}\u00b0C\n\u2022 Minimo: ${stats.min}\u00b0C\n\u2022 Maximo: ${stats.max}\u00b0C\n` +
        `\u2022 Ultima: ${stats.ultima.valor}\u00b0C${stats.ultima.tsLabel ? " as " + stats.ultima.tsLabel : ""}` };
    }

    // (7) contagem geral
    if (q.includes("quant") || q.includes("total") || q.includes("numero") || q.includes("quantidade")) {
      if (q.includes("empresa")) {
        const t = analytics.totaisGerais(empresas);
        return { text: `Ha ${t.empresas} empresa(s) monitorada(s), com ${t.lojas} loja(s) no total.` };
      }
      if (q.includes("loja") || q.includes("unidade")) {
        return { text: `Ha ${data.unidades.length} loja(s)/unidade(s) monitorada(s).` };
      }
      const crit = ativos.filter(isCrit).length;
      return { text: `Ha ${ativos.length} alarme(s) ativo(s) no momento, sendo ${crit} critico(s) (Alta + Critica). Monitorando ${data.unidades.length} loja(s).` };
    }

    return null; // nenhuma intencao casou -> deixa a IA responder
  }

  /* Fallback quando a IA esta indisponivel e nao ha intencao factual clara. */
  function fallbackChunks(retrieved) {
    if (retrieved.length) {
      return "Nao tenho um numero exato pra isso, mas os registros mais relevantes sao:\n\n" +
        retrieved.slice(0, 3).map((r, i) => `${i + 1}. ${r.chunk.text}`).join("\n\n");
    }
    return "Nao encontrei dados sobre isso. Tente perguntar sobre alarmes criticos, lojas, empresas, contratos a vencer, sinal de vida ou temperatura.";
  }

  function createEngine(data) {
    const chunks = buildChunks(data);
    const index = buildIndex(chunks);
    const cfg = window.GALILEO_CONFIG;

    return {
      chunksCount: chunks.length,

      /* factual-first: responde das regras quando a intencao e clara (sem
       * gastar IA); so chama o Gemini para perguntas abertas. */
      async ask(question, k = 5) {
        const retrieved = retrieve(question, index, k);
        const sources = retrieved.map((r) => ({
          id: r.chunk.id, type: r.chunk.type,
          score: Number(r.score.toFixed(3)), text: r.chunk.text,
        }));

        const factual = responderFactual(question, data);
        if (factual) return { answer: factual.text, sources, source: "regras", model: null };

        if (cfg && cfg.llm && cfg.llm.enabled) {
          try {
            const llmResult = await callLLM(question, retrieved, cfg.llm);
            return { answer: llmResult.answer, sources, source: "llm", model: llmResult.model };
          } catch (err) {
            console.warn("[rag] LLM indisponivel, usando fallback:", err.message);
          }
        }

        return { answer: fallbackChunks(retrieved), sources, source: "regras", model: null };
      },
    };
  }

  /* Faz a chamada HTTP para a function /api/llm. Aborta após timeoutMs. */
  async function callLLM(question, retrieved, llmCfg) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), llmCfg.timeoutMs || 20000);

    try {
      const res = await fetch(llmCfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          chunks: retrieved.map((r) => ({
            id: r.chunk.id,
            type: r.chunk.type,
            text: r.chunk.text,
            score: r.score,
          })),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }

      const data = await res.json();
      if (!data.answer) throw new Error("resposta sem campo 'answer'");
      return { answer: data.answer, model: data.model || "gemini" };
    } finally {
      clearTimeout(timeout);
    }
  }

  return { createEngine, _tokenize: tokenize };
})(window.GalileoAnalytics);
