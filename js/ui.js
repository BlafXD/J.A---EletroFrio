/* ui.js
 * --------------------------------------------------------------
 * Funções de renderização do DOM.
 * Mantém o `main.js` enxuto e separa apresentação de orquestração.
 * --------------------------------------------------------------
 */
window.GalileoUI = (function (analytics) {
  /* ---------- status ---------- */
  function setStatus(state, text) {
    const pill = document.getElementById("status-pill");
    const dot = pill?.querySelector(".dot");
    const t = document.getElementById("status-text");
    if (!pill || !dot || !t) return;

    dot.className = "dot";
    const stateClass = {
      idle: "dot--idle",
      load: "dot--load",
      ok: "dot--ok",
      err: "dot--err",
    }[state] || "dot--idle";
    dot.classList.add(stateClass);
    t.textContent = text;
  }

  /* ---------- relógio ---------- */
  function startClock() {
    const el = document.getElementById("clock");
    if (!el) return;
    const tick = () => {
      const d = new Date();
      el.textContent = d.toLocaleTimeString("pt-BR", { hour12: false });
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- KPIs ---------- */
  function renderKPIs(data) {
    const set = (id, val, delta) => {
      const v = document.getElementById(id);
      const d = document.getElementById(`${id}-delta`);
      if (v) v.textContent = val;
      if (d && delta !== undefined) d.textContent = delta;
    };

    const ativos = analytics.kpiTotalAtivos(data.alarmes);
    const criticos = analytics.kpiCriticos(data.alarmes);
    const unidades = analytics.kpiUnidades(data.unidades);
    const sinal24h = analytics.kpiSinalVida24h(data.unidades);
    const contratos = analytics.kpiContratosVencendo(data.unidades, 30);

    set("kpi-alarmes", ativos, `${data.meta.nAlarmesBrutos} brutos → ${ativos} tratados`);
    set("kpi-criticos", criticos, criticos === 0 ? "estável" : "atenção");
    set("kpi-unidades", unidades, `${data.meta.nUnidadesBrutas} brutas → ${unidades}`);
    set("kpi-sinalvida", sinal24h, `de ${unidades} unidades`);
    set("kpi-contratos", contratos, "próximos 30 dias");
  }

  /* ---------- Tabela de alarmes ---------- */
  function renderTabela(alarmes, filtros = {}) {
    const tbody = document.querySelector("#tabela-alarmes tbody");
    if (!tbody) return;

    const filtrados = alarmes.filter((a) => {
      if (!a.ativo) return false;
      if (filtros.criticidade && a.criticidade !== filtros.criticidade) return false;
      if (filtros.q) {
        const q = filtros.q.toLowerCase();
        const hay = `${a.lojaNm || ""} ${a.lojaApelido || ""} ${a.dispositivoNm || ""} ${a.alarmeDesc || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtrados.length) {
      tbody.innerHTML = `<tr class="datatable__empty"><td colspan="7">nenhum alarme ativo com os filtros atuais</td></tr>`;
      return;
    }

    const linhas = filtrados.map((a) => {
      const loja = a.lojaApelido || a.lojaNm || "—";
      const lojaSub = a.contaNm || "";
      const disp = a.dispositivoNm || "—";
      const grupo = [a.grupoNm, a.subgrupoNm].filter(Boolean).join(" / ") || "—";
      const desc = a.alarmeDesc || "—";
      const evento = a.eventoDesc || "sem evento";

      const critClass = {
        "Crítica": "tag--critica",
        Alta: "tag--alta",
        "Média": "tag--media",
        Baixa: "tag--baixa",
        Informativa: "tag--info",
      }[a.criticidade] || "tag--neutral";

      const tempoAberto = analytics.formatTempoAberto(a.alarmeDhCad);
      const contrato = a.loja_contrato || a.tpContratoNm || "—";
      const venc = a.loja_dtValContrato
        ? a.loja_dtValContrato.toLocaleDateString("pt-BR")
        : "—";
      const sinal = a.loja_dhSinalVida
        ? a.loja_dhSinalVida.toLocaleString("pt-BR")
        : "—";

      return `
        <tr>
          <td>
            <div>${escapeHTML(loja)}</div>
            <div class="cell-mono">${escapeHTML(lojaSub)}</div>
          </td>
          <td>
            <div>${escapeHTML(disp)}</div>
            <div class="cell-mono">${escapeHTML(grupo)}</div>
          </td>
          <td class="cell-desc">
            ${escapeHTML(desc)}
            <small>${escapeHTML(evento)}</small>
          </td>
          <td><span class="tag ${critClass}">${escapeHTML(a.criticidade || "—")}</span></td>
          <td class="cell-mono">${escapeHTML(tempoAberto)}</td>
          <td>
            <div>${escapeHTML(contrato)}</div>
            <div class="cell-mono">vence ${escapeHTML(venc)}</div>
          </td>
          <td class="cell-mono">${escapeHTML(sinal)}</td>
        </tr>
      `;
    });

    tbody.innerHTML = linhas.join("");
  }

  function escapeHTML(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------- RAG ---------- */
  function renderAnswer({ answer, sources, source, model }) {
    const box = document.getElementById("rag-answer");
    if (!box) return;
    const paragraphs = answer.split("\n").map((p) => p.trim()).filter(Boolean);

    // Badge indicando origem da resposta
    let badgeHtml = "";
    if (source === "llm") {
      badgeHtml = `<div class="rag__badge rag__badge--llm">via ${escapeHTML(model || "Gemini")}</div>`;
    } else if (source === "rules") {
      badgeHtml = `<div class="rag__badge rag__badge--rules">via regras (fallback)</div>`;
    } else if (source === "error") {
      badgeHtml = `<div class="rag__badge rag__badge--err">erro</div>`;
    }

    const ans = paragraphs.map((p) => `<p>${escapeHTML(p)}</p>`).join("");
    let srcHtml = "";
    if (sources && sources.length) {
      const items = sources
        .slice(0, 4)
        .map(
          (s) => `
          <div class="rag__source">
            <div class="rag__source-meta">
              <span class="rag__num">${s.type}</span> · score ${s.score} · id ${escapeHTML(s.id)}
            </div>
            ${escapeHTML(s.text)}
          </div>`
        )
        .join("");
      srcHtml = `
        <div class="rag__sources">
          <div class="rag__sources-title">chunks fonte (top ${Math.min(sources.length, 4)})</div>
          ${items}
        </div>`;
    }
    box.innerHTML = badgeHtml + ans + srcHtml;
  }

  function renderAnswerLoading() {
    const box = document.getElementById("rag-answer");
    if (!box) return;
    box.innerHTML = `
      <div class="rag__loading">
        <span class="rag__loading-dots"><span></span><span></span><span></span></span>
        <span class="rag__loading-text">recuperando chunks · consultando Gemini · sintetizando</span>
      </div>`;
  }

  function setTelemetriaMeta(text) {
    const el = document.getElementById("telemetria-meta");
    if (el) el.textContent = text;
  }

  return {
    setStatus,
    startClock,
    renderKPIs,
    renderTabela,
    renderAnswer,
    renderAnswerLoading,
    setTelemetriaMeta,
  };
})(window.GalileoAnalytics);
