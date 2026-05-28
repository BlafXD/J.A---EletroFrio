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

  /* ---------- síntese ----------
   * Heurísticas leves sobre a intenção da pergunta. Para cada padrão
   * conhecido, geramos a resposta a partir dos dados estruturados
   * (não a partir dos chunks textuais — isso evita alucinação).
   * Os chunks retornados pelo retriever entram como "fontes".
   */
  function synthesize(question, retrieved, data) {
    const q = tokenize(question).join(" ");
    const lojaIndex = new Map();
    for (const u of data.unidades) {
      if (u.lojaId) lojaIndex.set(String(u.lojaId), u);
    }

    /* (1) Top lojas com mais alarmes críticos ativos */
    if (
      (q.includes("loja") || q.includes("lojas") || q.includes("unidade")) &&
      (q.includes("critic") || q.includes("alta") || q.includes("urgente") || q.includes("graves"))
    ) {
      const ativosCriticos = data.alarmes.filter(
        (a) => a.ativo && (a.criticidade === "Alta" || a.criticidade === "Crítica")
      );
      const por = new Map();
      for (const a of ativosCriticos) {
        const nome = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}`;
        por.set(nome, (por.get(nome) || 0) + 1);
      }
      const top = [...por.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

      if (!top.length) {
        return {
          text: "Não há alarmes graves (Alta ou Crítica) ativos no momento.",
        };
      }
      const lista = top.map(([n, q]) => `• ${n}: ${q} alarme(s) grave(s)`).join("\n");
      return {
        text: `Lojas com mais alarmes graves (Alta + Crítica) ativos:\n\n${lista}\n\nTotal: ${ativosCriticos.length}.`,
      };
    }

    /* (2) Sem sinal de vida */
    if (q.includes("sinal") && (q.includes("vida") || q.includes("offline") || q.includes("comunic"))) {
      const horas = q.includes("48") ? 48 : 24;
      const sem = analytics.semSinalVida(data.unidades, horas);
      if (!sem.length) {
        return { text: `Todas as unidades tiveram sinal de vida nas últimas ${horas}h.` };
      }
      const lista = sem
        .slice(0, 10)
        .map(
          (u) =>
            `• ${u.loja}: ${u.horas_sem_sinal === null ? "sem registro" : `${u.horas_sem_sinal}h sem sinal`}`
        )
        .join("\n");
      return {
        text: `Dispositivos sem sinal de vida há mais de ${horas}h (${sem.length} total):\n\n${lista}`,
      };
    }

    /* (3) Contratos próximos do vencimento (com hipótese de alarmes) */
    if ((q.includes("contrato") || q.includes("vencimento") || q.includes("vencer")) && q.length) {
      const lista = analytics.contratosComMaisAlarmes(data.alarmes, data.unidades, 8);
      if (!lista.length) {
        return { text: "Nenhum contrato vencendo nos próximos 60 dias." };
      }
      const linhas = lista
        .map(
          (l) =>
            `• ${l.loja} — vence em ${l.vence_em_dias}d, contrato ${l.contrato || "—"}, ${l.alarmes_ativos} alarme(s) ativo(s)`
        )
        .join("\n");
      const corr = lista.filter((l) => l.alarmes_ativos > 0).length;
      return {
        text:
          `Contratos a vencer nos próximos 60 dias (${lista.length}):\n\n${linhas}\n\n` +
          `Hipótese: ${corr} de ${lista.length} unidades a vencer apresentam alarmes ativos.`,
      };
    }

    /* (4) Telemetria / temperatura média */
    if (q.includes("temperatura") || q.includes("media") || q.includes("medio") || q.includes("telemetria")) {
      const stats = analytics.statsTelemetria(data.telemetria);
      if (!stats) {
        return { text: "Não há leituras de telemetria carregadas no momento." };
      }
      const seriesNames =
        data.telemetriaSeries && data.telemetriaSeries.length
          ? data.telemetriaSeries.map((s) => s.label).join(", ")
          : "—";
      return {
        text:
          `Telemetria do dispositivo ${data.telemetriaDispositivoId || "—"} ` +
          `(série principal "Temperatura Ambiente", ${stats.n} leituras válidas, nulos do fim descartados):\n\n` +
          `• média: ${stats.avg} °C\n• mínimo: ${stats.min} °C\n• máximo: ${stats.max} °C\n` +
          `• última leitura: ${stats.ultima.valor} em ${stats.ultima.tsLabel || stats.ultima.ts.toLocaleString("pt-BR")}\n\n` +
          `Séries disponíveis no dispositivo: ${seriesNames}.`,
      };
    }

    /* (5) Quantos alarmes */
    if (q.includes("quantos") || q.includes("total") || q.includes("numero")) {
      const ativos = data.alarmes.filter((a) => a.ativo);
      const criticos = ativos.filter((a) => a.criticidade === "Alta").length;
      return {
        text:
          `Há ${ativos.length} alarme(s) ativo(s) no momento, ` +
          `sendo ${criticos} de criticidade Alta. ` +
          `Total de unidades monitoradas: ${data.unidades.length}.`,
      };
    }

    /* fallback: retorna o melhor chunk como contexto */
    if (retrieved.length) {
      return {
        text:
          "Não tenho uma resposta agregada exata para isso, mas os trechos mais relevantes ao que você perguntou são:\n\n" +
          retrieved
            .slice(0, 3)
            .map((r, i) => `${i + 1}. ${r.chunk.text}`)
            .join("\n\n"),
      };
    }

    return {
      text:
        "Não encontrei dados relacionados a essa pergunta. " +
        "Tente perguntas sobre alarmes críticos, lojas, contratos a vencer, sinal de vida ou temperatura.",
    };
  }

  /* ---------- API pública ---------- */
  function createEngine(data) {
    const chunks = buildChunks(data);
    const index = buildIndex(chunks);
    const cfg = window.GALILEO_CONFIG;

    return {
      chunksCount: chunks.length,

      /* Pipeline RAG completo:
       *   1. retrieve()   — TF-IDF cosseno, top-K chunks
       *   2. callLLM()    — manda { question, chunks } para a function /api/llm
       *                     que chama o Gemini 2.5 Flash com a chave do env
       *   3. fallback     — se o LLM falhar (rede, quota, erro), usa o
       *                     synthesize() baseado em regras como rede de segurança
       *
       * Retorna { answer, sources, source, model }.
       */
      async ask(question, k = 5) {
        const retrieved = retrieve(question, index, k);

        // Tentar LLM primeiro (se habilitado)
        if (cfg && cfg.llm && cfg.llm.enabled) {
          try {
            const llmResult = await callLLM(question, retrieved, cfg.llm);
            return {
              answer: llmResult.answer,
              sources: retrieved.map((r) => ({
                id: r.chunk.id,
                type: r.chunk.type,
                score: Number(r.score.toFixed(3)),
                text: r.chunk.text,
              })),
              source: "llm",
              model: llmResult.model,
            };
          } catch (err) {
            console.warn("[rag] LLM falhou, usando regras como fallback:", err.message);
            // cai no fallback abaixo
          }
        }

        // Fallback determinístico baseado em regras
        const { text } = synthesize(question, retrieved, data);
        return {
          answer: text,
          sources: retrieved.map((r) => ({
            id: r.chunk.id,
            type: r.chunk.type,
            score: Number(r.score.toFixed(3)),
            text: r.chunk.text,
          })),
          source: "rules",
          model: null,
        };
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
