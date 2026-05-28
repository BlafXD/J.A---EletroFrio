/* main.js
 * --------------------------------------------------------------
 * Orquestrador: amarra todos os módulos. Mantém o estado da PoC
 * em memória (state.data) e re-renderiza quando muda.
 *
 * Fluxo de uma carga:
 *   1) API → JSON cru de alarmes/unidades/telemetria
 *   2) Processor → normaliza, deduplica, descarta últimos 5 da telemetria
 *   3) Processor → enriquece alarmes com cadastro da loja (join)
 *   4) Analytics → calcula KPIs e séries para os charts
 *   5) Charts/UI → renderiza
 *   6) RAG → reindexa chunks textuais para consulta
 * --------------------------------------------------------------
 */
(function () {
  const cfg = window.GALILEO_CONFIG;
  const api = window.GalileoAPI;
  const proc = window.GalileoProcessor;
  const charts = window.GalileoCharts;
  const ui = window.GalileoUI;
  const analytics = window.GalileoAnalytics;
  const rag = window.GalileoRAG;

  const state = {
    data: null,
    ragEngine: null,
    currentDispositivoId: cfg.telemetria.defaultDispositivoId,
  };

  /* ---------- carregamento inicial ---------- */
  async function load() {
    ui.setStatus("load", "ingerindo endpoints…");
    try {
      const [alarmesRaw, unidadesRaw, telemetriaRaw] = await Promise.all([
        api.getAlarmes(),
        api.getUnidades(),
        api.getTelemetria(state.currentDispositivoId),
      ]);

      ui.setStatus("load", "normalizando e enriquecendo…");
      const data = proc.process({ alarmesRaw, unidadesRaw, telemetriaRaw });
      data.telemetriaDispositivoId = state.currentDispositivoId;
      state.data = data;

      ui.setStatus("load", "renderizando dashboard…");
      renderAll();

      ui.setStatus("load", "indexando para RAG…");
      state.ragEngine = rag.createEngine(data);

      ui.setStatus(
        "ok",
        `ok · ${data.alarmes.filter((a) => a.ativo).length} alarmes ativos · ` +
          `${state.ragEngine.chunksCount} chunks indexados`
      );
      console.info("[main] pipeline finalizado", data.meta);
    } catch (e) {
      console.error("[main] falha no pipeline", e);
      ui.setStatus("err", e.message || "erro desconhecido");
    }
  }

  /* ---------- só telemetria (mudança de dispositivo) ---------- */
  async function reloadTelemetria(dispositivoId) {
    if (!state.data) return;
    ui.setStatus("load", `coletando telemetria do dispositivo ${dispositivoId}…`);
    try {
      const raw = await api.getTelemetria(dispositivoId);
      const processed = proc.process({
        alarmesRaw: [],
        unidadesRaw: [],
        telemetriaRaw: raw,
      });

      state.data.telemetria = processed.telemetria;
      state.data.telemetriaSeries = processed.telemetriaSeries;
      state.data.telemetriaDispositivoId = dispositivoId;
      state.currentDispositivoId = dispositivoId;

      renderTelemetria();
      // Reindexa pra o RAG falar sobre o novo dispositivo
      state.ragEngine = rag.createEngine(state.data);
      ui.setStatus(
        "ok",
        `telemetria atualizada · ${processed.telemetriaSeries.length} série(s), ` +
          `${processed.telemetria.length} pontos na principal`
      );
    } catch (e) {
      ui.setStatus("err", `falha telemetria: ${e.message}`);
    }
  }

  /* ---------- render orquestrado ---------- */
  function renderAll() {
    const d = state.data;
    if (!d) return;

    ui.renderKPIs(d);

    charts.renderCriticidade("chart-criticidade", analytics.porCriticidade(d.alarmes));
    charts.renderTopLojas("chart-lojas", analytics.topLojasPorAlarmes(d.alarmes, 10));
    renderTelemetria();

    ui.renderTabela(d.alarmes, getFiltrosTabela());
  }

  function renderTelemetria() {
    const d = state.data;
    if (!d) return;
    charts.renderTelemetria("chart-telemetria", d.telemetriaSeries || [], {
      dispositivoNm: `dispositivo ${state.currentDispositivoId}`,
    });
    const stats = analytics.statsTelemetria(d.telemetria);
    const nSeries = d.telemetriaSeries?.length || 0;
    ui.setTelemetriaMeta(
      stats
        ? `dispositivoId ${state.currentDispositivoId} · ${nSeries} série(s) · ` +
            `principal: ${stats.n} pontos · ` +
            `média ${stats.avg} · min ${stats.min} · max ${stats.max} · valores nulos do fim descartados`
        : `dispositivoId ${state.currentDispositivoId} · sem leituras válidas`
    );
  }

  /* ---------- filtros da tabela ---------- */
  function getFiltrosTabela() {
    return {
      criticidade: document.getElementById("filtro-critic")?.value || "",
      q: document.getElementById("busca-alarme")?.value || "",
    };
  }

  /* ---------- handlers ---------- */
  function bindEvents() {
    document.getElementById("refresh-btn")?.addEventListener("click", load);

    document.getElementById("filtro-critic")?.addEventListener("change", () => {
      if (state.data) ui.renderTabela(state.data.alarmes, getFiltrosTabela());
    });

    let buscaTO;
    document.getElementById("busca-alarme")?.addEventListener("input", () => {
      clearTimeout(buscaTO);
      buscaTO = setTimeout(() => {
        if (state.data) ui.renderTabela(state.data.alarmes, getFiltrosTabela());
      }, 200);
    });

    document.getElementById("dispositivo-btn")?.addEventListener("click", () => {
      const inp = document.getElementById("dispositivo-input");
      const id = String(inp?.value || "").trim();
      if (id) reloadTelemetria(id);
    });

    document.getElementById("dispositivo-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("dispositivo-btn")?.click();
      }
    });

    // RAG
    const form = document.getElementById("rag-form");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      const txt = document.getElementById("rag-input")?.value || "";
      askRAG(txt);
    });

    document.querySelectorAll(".chip[data-q]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = btn.getAttribute("data-q") || "";
        const inp = document.getElementById("rag-input");
        if (inp) inp.value = q;
        askRAG(q);
      });
    });

    // polling automático (alarmes a cada 5 min)
    setInterval(() => {
      if (state.data) {
        console.info("[main] polling automático de alarmes/unidades");
        load();
      }
    }, cfg.polling.alarmes_ms);
  }

  async function askRAG(question) {
    const q = String(question || "").trim();
    if (!q) return;
    if (!state.ragEngine) {
      ui.renderAnswer({
        answer: "Aguarde a ingestão inicial dos dados terminar para usar o RAG.",
        sources: [],
      });
      return;
    }
    ui.renderAnswerLoading();
    try {
      const result = await state.ragEngine.ask(q, 5);
      ui.renderAnswer(result);
    } catch (e) {
      console.error("[main] askRAG erro:", e);
      ui.renderAnswer({
        answer: "Falha ao processar a pergunta: " + e.message,
        sources: [],
        source: "error",
      });
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    ui.startClock();
    bindEvents();
    // garante que Chart.js carregou (script com defer)
    if (typeof Chart === "undefined") {
      window.addEventListener("load", load);
    } else {
      load();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
