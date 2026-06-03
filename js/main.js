/* ============================================================
   main.js — orquestração do dashboard "Freezer Controle"
   Mantém a camada de dados (api/processor/analytics/rag) intacta;
   só muda a apresentação (por empresa).
   ============================================================ */
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
    empresas: [],
    ragEngine: null,
    filtroCriticos: false,
  };

  /* ---------- carregamento ---------- */
  async function load() {
    ui.setStatus("loading", "Carregando dados…");
    try {
      const [alarmesRaw, unidadesRaw, telemetriaRaw] = await Promise.all([
        api.getAlarmes(),
        api.getUnidades(),
        api.getTelemetria(cfg.telemetria.defaultDispositivoId),
      ]);

      const data = proc.process({ alarmesRaw, unidadesRaw, telemetriaRaw });
      state.data = data;
      state.empresas = analytics.porEmpresa(data.alarmes, data.unidades);

      renderAll();

      // indexa para o assistente (RAG) — não bloqueia o dashboard se falhar
      try {
        state.ragEngine = rag.createEngine(data);
      } catch (e) {
        console.warn("[main] RAG não pôde ser indexado:", e);
      }

      const t = analytics.totaisGerais(state.empresas);
      ui.setStatus("ok", `${t.empresas} empresas · ${t.lojas} lojas · ${t.alarmes} alarmes`);
      console.info("[main] pipeline ok", data.meta);
    } catch (e) {
      console.error("[main] falha no pipeline:", e);
      ui.setStatus("error", "Falha ao carregar. Nova tentativa no próximo ciclo.");
    }
  }

  /* ---------- render orquestrado ---------- */
  function renderAll() {
    const totais = analytics.totaisGerais(state.empresas);
    ui.renderKPIs(totais);
    charts.renderEmpresas("chart-empresas", analytics.topEmpresasAlarmes(state.empresas, 8));
    aplicarFiltro();
    bindVerCriticos();
  }

  function aplicarFiltro() {
    const termo = (document.getElementById("busca-empresa")?.value || "").trim().toLowerCase();
    let lista = state.empresas;
    if (state.filtroCriticos) lista = lista.filter((e) => e.criticos > 0);
    if (termo) lista = lista.filter((e) => String(e.contaNm).toLowerCase().includes(termo));
    ui.renderEmpresas(lista);
  }

  function bindVerCriticos() {
    const btn = document.getElementById("ver-criticos");
    if (!btn) return;
    btn.addEventListener("click", () => {
      state.filtroCriticos = !state.filtroCriticos;
      btn.textContent = state.filtroCriticos ? "Mostrar todas" : "Ver todos";
      aplicarFiltro();
      document.getElementById("empresa-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /* ---------- handlers ---------- */
  function bindEvents() {
    let buscaTO;
    document.getElementById("busca-empresa")?.addEventListener("input", () => {
      clearTimeout(buscaTO);
      buscaTO = setTimeout(aplicarFiltro, 180);
    });

    document.getElementById("chat-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const inp = document.getElementById("chat-input");
      const q = String(inp?.value || "").trim();
      if (!q) return;
      inp.value = "";
      askRAG(q);
    });

    // polling automático (alarmes/unidades a cada 5 min)
    setInterval(() => {
      if (state.data) {
        console.info("[main] polling automático");
        load();
      }
    }, cfg.polling.alarmes_ms);
  }

  /* ---------- assistente (RAG) ---------- */
  async function askRAG(question) {
    ui.chatUser(question);
    const node = ui.chatTyping();
    if (!state.ragEngine) {
      ui.chatBot({ answer: "Ainda estou indexando os dados — tente novamente em instantes.", source: "regras" }, node);
      return;
    }
    try {
      const result = await state.ragEngine.ask(question, 5);
      ui.chatBot(result, node);
    } catch (e) {
      console.error("[main] askRAG erro:", e);
      ui.chatBot({ answer: "Falha ao processar a pergunta: " + e.message, source: "error" }, node);
    }
  }

  /* ---------- boot ---------- */
  function boot() {
    ui.renderParametros();
    bindEvents();
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
