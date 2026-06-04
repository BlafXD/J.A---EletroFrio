/* ============================================================
   admin-page.js — central de alarmes (tabela + filtros + CSV)
   ============================================================ */
(function () {
  const api = window.GalileoAPI;
  const proc = window.GalileoProcessor;
  const analytics = window.GalileoAnalytics;
  const ui = window.GalileoUI;
  const esc = ui.escapeHTML;

  const RANK = { "Crítica": 5, "Alta": 4, "Média": 3, "Baixa": 2, "Informativa": 1, "Sem classificação": 0 };
  const NIVEIS = ["Crítica", "Alta", "Média", "Baixa", "Informativa"];

  const state = { alarmes: [], filtroCrit: "todas", busca: "" };

  function critClass(c) {
    switch (c) {
      case "Crítica": return "crit--critica";
      case "Alta": return "crit--alta";
      case "Média": return "crit--media";
      case "Baixa": return "crit--baixa";
      default: return "crit--info";
    }
  }
  function tsAlarme(a) {
    const t = a.alarmeDhCad ? new Date(a.alarmeDhCad).getTime() : NaN;
    return isNaN(t) ? Infinity : t;
  }
  function tempoAberto(a) {
    if (a.tempo) return a.tempo;
    if (a.alarmeDhCad && analytics.formatTempoAberto) return analytics.formatTempoAberto(new Date(a.alarmeDhCad));
    return "—";
  }
  function ordenar(lista) {
    return [...lista].sort((x, y) => {
      const r = (RANK[y.criticidade] || 0) - (RANK[x.criticidade] || 0);
      if (r !== 0) return r;
      return tsAlarme(x) - tsAlarme(y); // mais antigo (aberto há mais tempo) primeiro
    });
  }
  function filtrar() {
    let lista = state.alarmes;
    if (state.filtroCrit !== "todas") lista = lista.filter((a) => a.criticidade === state.filtroCrit);
    const q = state.busca.trim().toLowerCase();
    if (q) {
      lista = lista.filter((a) =>
        [a.lojaNm, a.contaNm, a.dispositivoNm, a.alarmeDesc, a.grupoNm, a.subgrupoNm]
          .filter(Boolean).join(" ").toLowerCase().includes(q));
    }
    return ordenar(lista);
  }

  function renderFiltros() {
    const cont = analytics.porCriticidade(state.alarmes);
    const chips = [`<button class="chip-filtro ${state.filtroCrit === "todas" ? "is-active" : ""}" data-crit="todas">Todas <span>${state.alarmes.length}</span></button>`];
    for (const n of NIVEIS) {
      const c = cont[n] || 0;
      if (c === 0) continue;
      chips.push(`<button class="chip-filtro ${state.filtroCrit === n ? "is-active" : ""}" data-crit="${esc(n)}">${esc(n)} <span>${c}</span></button>`);
    }
    const el = document.getElementById("filtros");
    el.innerHTML = chips.join("");
    el.querySelectorAll(".chip-filtro").forEach((b) => {
      b.addEventListener("click", () => {
        state.filtroCrit = b.dataset.crit;
        renderFiltros();
        renderTabela();
      });
    });
  }

  function renderTabela() {
    const lista = filtrar();
    const body = document.getElementById("alarmes-body");
    if (!lista.length) {
      body.innerHTML = '<div class="alarmes-empty">Nenhum alarme corresponde aos filtros. 🎉</div>';
    } else {
      body.innerHTML = lista.map((a) => {
        const href = a.lojaId ? `loja.html?lojaId=${encodeURIComponent(a.lojaId)}` : "#";
        return `<a class="alarme-linha" href="${href}">
          <span class="cel-crit"><span class="crit-badge ${critClass(a.criticidade)}">${esc(a.criticidade || "—")}</span></span>
          <span class="cel-loja cel-trunc" data-col="Loja" title="${esc(a.lojaNm)}">${esc(a.lojaNm || "—")}</span>
          <span class="cel-sub cel-trunc" data-col="Empresa" title="${esc(a.contaNm)}">${esc(a.contaNm || "—")}</span>
          <span class="cel-sub cel-trunc" data-col="Dispositivo" title="${esc(a.dispositivoNm)}">${esc(a.dispositivoNm || "—")}</span>
          <span class="cel-trunc" data-col="Alarme" title="${esc(a.alarmeDesc)}">${esc(a.alarmeDesc || a.grupoNm || "—")}</span>
          <span class="cel-tempo" data-col="Aberto há">${esc(tempoAberto(a))}</span>
        </a>`;
      }).join("");
    }
    const r = document.getElementById("resumo");
    if (r) r.textContent = `Exibindo ${lista.length} de ${state.alarmes.length} alarmes ativos.`;
  }

  function exportarCSV() {
    const lista = filtrar();
    const linhas = [["Criticidade", "Loja", "Empresa", "Dispositivo", "Alarme", "Grupo", "Aberto há", "Aberto em"]];
    for (const a of lista) {
      linhas.push([
        a.criticidade || "", a.lojaNm || "", a.contaNm || "", a.dispositivoNm || "",
        a.alarmeDesc || "", [a.grupoNm, a.subgrupoNm].filter(Boolean).join(" / "),
        tempoAberto(a), a.alarmeDhCad ? new Date(a.alarmeDhCad).toLocaleString("pt-BR") : "",
      ]);
    }
    const csv = linhas.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `alarmes-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  }

  async function load() {
    ui.setStatus("loading", "Carregando alarmes…");
    try {
      const [alarmesRaw, unidadesRaw] = await Promise.all([api.getAlarmes(), api.getUnidades()]);
      const data = proc.process({ alarmesRaw, unidadesRaw, telemetriaRaw: [] });
      state.alarmes = data.alarmes.filter((a) => a.ativo);
      renderFiltros();
      renderTabela();
      const crit = state.alarmes.filter((a) => analytics.isCritico(a)).length;
      ui.setStatus("ok", `${state.alarmes.length} alarmes ativos · ${crit} críticos`);
    } catch (e) {
      console.error("[admin] falha:", e);
      ui.setStatus("error", "Falha ao carregar alarmes.");
      document.getElementById("alarmes-body").innerHTML = '<div class="alarmes-empty">Não foi possível carregar os alarmes.</div>';
    }
  }

  function boot() {
    let to;
    document.getElementById("busca").addEventListener("input", (e) => {
      state.busca = e.target.value;
      clearTimeout(to);
      to = setTimeout(renderTabela, 160);
    });
    document.getElementById("btn-export").addEventListener("click", exportarCSV);
    load();
    const ms = (window.GALILEO_CONFIG && window.GALILEO_CONFIG.polling && window.GALILEO_CONFIG.polling.alarmes_ms) || 300000;
    setInterval(load, ms);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
