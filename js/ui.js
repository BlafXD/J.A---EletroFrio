/* ============================================================
   ui.js — renderização do dashboard "Freezer Controle"
   ============================================================ */
window.GalileoUI = (function (analytics) {
  /* ---------- ícones SVG reutilizáveis ---------- */
  const ICON = {
    building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/></svg>',
    snowflake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M12 2v20"/><path d="m20 16-4-4 4-4"/><path d="m4 8 4 4-4 4"/><path d="m16 4-4 4-4-4"/><path d="m8 20 4-4 4 4"/></svg>',
    shieldCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  };

  /* ---------- parâmetros de temperatura (referência fixa) ---------- */
  const PARAMETROS = [
    { tipo: "Freezer / Congelados", min: -22, max: -18, desc: "Sorvetes, congelados, carnes" },
    { tipo: "Câmara fria de congelados", min: -25, max: -20, desc: "Estocagem profunda" },
    { tipo: "Geladeira / Refrigerados", min: 2, max: 8, desc: "Laticínios, frios, FLV" },
    { tipo: "Câmara fria de resfriados", min: 0, max: 4, desc: "Carnes resfriadas" },
    { tipo: "Açougue / Balcão de carnes", min: 0, max: 4, desc: "Exposição de carnes" },
    { tipo: "Padaria / Confeitaria fria", min: 4, max: 10, desc: "Tortas, doces refrigerados" },
    { tipo: "Ilha de bebidas", min: 4, max: 7, desc: "Bebidas geladas" },
    { tipo: "Ambiente climatizado", min: 18, max: 24, desc: "Sala de vendas" },
  ];

  function escapeHTML(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- status pill ---------- */
  function setStatus(state, text) {
    const el = document.getElementById("status");
    const txt = document.getElementById("status-text");
    if (el) el.dataset.state = state;
    if (txt && text != null) txt.textContent = text;
  }

  /* ---------- parâmetros ---------- */
  function renderParametros() {
    const grid = document.getElementById("param-grid");
    if (!grid) return;
    grid.innerHTML = PARAMETROS.map((p) => {
      const frio = p.max <= 0;
      const icon = frio ? `<span class="param__icon">${ICON.snowflake}</span>` : "";
      return `
        <div class="param ${frio ? "param--frio" : ""}">
          <div class="param__top">${icon}<span class="param__name">${escapeHTML(p.tipo)}</span></div>
          <div class="param__range">${p.min}° a ${p.max}°C</div>
          <div class="param__desc">${escapeHTML(p.desc)}</div>
        </div>`;
    }).join("");
  }

  /* ---------- KPIs ---------- */
  function renderKPIs(totais) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set("kpi-empresas", totais.empresas);
    set("kpi-lojas", totais.lojas);
    set("kpi-alarmes", totais.alarmes);
    set("kpi-criticos", totais.criticos);

    const action = document.getElementById("kpi-criticos-action");
    if (action) {
      action.innerHTML = totais.criticos > 0
        ? '<button class="btn btn--danger btn--sm" id="ver-criticos">Ver todos</button>'
        : "";
    }
  }

  /* ---------- cards de empresa ---------- */
  function badgeEmpresa(e) {
    if (e.criticos > 0) {
      return `<span class="badge badge--danger">${ICON.alert}${e.criticos} crítico${e.criticos > 1 ? "s" : ""}</span>`;
    }
    if (e.alarmes === 0) {
      return `<span class="badge badge--ok">${ICON.shieldCheck}OK</span>`;
    }
    return `<span class="badge badge--warn">${e.alarmes} alarme${e.alarmes > 1 ? "s" : ""}</span>`;
  }

  function renderEmpresas(empresas, opts = {}) {
    const grid = document.getElementById("empresa-grid");
    if (!grid) return;

    if (!empresas.length) {
      grid.innerHTML = '<div class="empty">Nenhuma empresa encontrada.</div>';
      return;
    }

    grid.innerHTML = empresas.map((e) => `
      <a class="card empresa" href="empresa.html?contaId=${encodeURIComponent(e.contaId)}" data-conta="${escapeHTML(e.contaId)}">
        <div class="empresa__head">
          <span class="empresa__icon">${ICON.building}</span>
          <div class="empresa__id">
            <div class="empresa__name" title="${escapeHTML(e.contaNm)}">${escapeHTML(e.contaNm)}</div>
            <div class="empresa__sub">ID conta ${escapeHTML(e.contaId)}</div>
          </div>
          ${badgeEmpresa(e)}
        </div>
        <div class="empresa__stats">
          <div class="mini"><div class="mini__value">${e.lojas.length}</div><div class="mini__label">Lojas</div></div>
          <div class="mini"><div class="mini__value">${e.alarmes}</div><div class="mini__label">Alarmes</div></div>
          <div class="mini"><div class="mini__value ${e.criticos ? "is-danger" : ""}">${e.criticos}</div><div class="mini__label">Críticos</div></div>
        </div>
      </a>`).join("");

    if (typeof opts.onSelect === "function") {
      grid.querySelectorAll(".empresa").forEach((card) => {
        card.addEventListener("click", (ev) => {
          ev.preventDefault();
          opts.onSelect(card.dataset.conta);
        });
      });
    }
  }

  /* ---------- chat (assistente / RAG) ---------- */
  function chatScroll() {
    const log = document.getElementById("chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  }

  function chatUser(text) {
    const log = document.getElementById("chat-log");
    if (!log) return;
    const div = document.createElement("div");
    div.className = "msg msg--user";
    div.textContent = text;
    log.appendChild(div);
    chatScroll();
  }

  function chatTyping() {
    const log = document.getElementById("chat-log");
    if (!log) return null;
    const div = document.createElement("div");
    div.className = "msg msg--bot";
    div.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
    log.appendChild(div);
    chatScroll();
    return div;
  }

  function chatBot({ answer, source, sources }, node) {
    const log = document.getElementById("chat-log");
    if (!log) return;
    const div = node || document.createElement("div");
    div.className = "msg msg--bot";

    let meta = "";
    if (source) {
      const isGemini = /gemini|llm/i.test(source);
      const cls = isGemini ? "origin--gemini" : "origin--regras";
      const label = isGemini ? "via Gemini" : "via regras";
      meta = `<div class="msg__meta"><span class="origin ${cls}">${label}</span>`;
      if (sources && sources.length) {
        meta += `<span>· ${sources.length} fonte${sources.length > 1 ? "s" : ""}</span>`;
      }
      meta += "</div>";
    }
    div.innerHTML = `<div>${escapeHTML(answer).replace(/\n/g, "<br>")}</div>${meta}`;
    if (!node) log.appendChild(div);
    chatScroll();
  }

  return {
    setStatus,
    renderParametros,
    renderKPIs,
    renderEmpresas,
    chatUser,
    chatBot,
    chatTyping,
    escapeHTML,
    PARAMETROS,
  };
})(window.GalileoAnalytics);
