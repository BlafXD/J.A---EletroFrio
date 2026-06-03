/* ============================================================
   charts.js — gráficos (tema claro "Freezer Controle")
   ============================================================ */
window.GalileoCharts = (function () {
  const palette = {
    critico: "#d8443c",
    demais: "#f0a531",
    primary: "#2178ce",
    accent: "#2bacc6",
    grid: "#e8eef4",
    text: "#5a6577",
    muted: "#8a93a3",
  };

  let themeApplied = false;
  function applyTheme() {
    if (themeApplied || typeof Chart === "undefined") return;
    Chart.defaults.color = palette.text;
    Chart.defaults.borderColor = palette.grid;
    Chart.defaults.font.family = "'Plus Jakarta Sans', system-ui, sans-serif";
    Chart.defaults.font.size = 12;
    themeApplied = true;
  }

  const instances = new Map();
  function destroyIfExists(canvasId) {
    const inst = instances.get(canvasId);
    if (inst) { inst.destroy(); instances.delete(canvasId); }
  }

  /* Barras empilhadas: alarmes por empresa (críticos + demais) */
  function renderEmpresas(canvasId, empresas) {
    applyTheme();
    destroyIfExists(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    const labels = empresas.map((e) => e.contaNm);
    const criticos = empresas.map((e) => e.criticos);
    const demais = empresas.map((e) => Math.max(0, e.alarmes - e.criticos));
    const inst = new Chart(el, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Críticos", data: criticos, backgroundColor: palette.critico, borderRadius: 4, maxBarThickness: 60, stack: "a" },
          { label: "Demais", data: demais, backgroundColor: palette.demais, borderRadius: 4, maxBarThickness: 60, stack: "a" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, padding: 16 } },
          tooltip: { padding: 10, boxPadding: 4, usePointStyle: true },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, maxRotation: 30, minRotation: 0, font: { size: 11 } } },
          y: { stacked: true, beginAtZero: true, grid: { color: palette.grid }, border: { display: false }, ticks: { precision: 0 } },
        },
      },
    });
    instances.set(canvasId, inst);
    return inst;
  }

  /* Telemetria (multi-série) — página da loja.
     series: [{ label, color, points:[{tsLabel, valor}] }] (formato do processor) */
  function renderTelemetria(canvasId, series) {
    applyTheme();
    destroyIfExists(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;
    series = Array.isArray(series) ? series.filter((s) => s && s.points && s.points.length) : [];
    if (!series.length) return;

    // eixo x = labels da série com mais pontos
    const base = series.reduce((a, b) => (b.points.length > a.points.length ? b : a), series[0]);
    const labels = base.points.map((p) => p.tsLabel);

    const colorFor = (label, i) => {
      const l = (label || "").toLowerCase();
      if (l.includes("setpoint")) return palette.demais;
      if (l.includes("temperatura ambiente") || (l.includes("temperatura") && !/degelo|suc|evap/.test(l))) return palette.primary;
      const cyc = [palette.primary, palette.accent, palette.critico, palette.demais, "#8b5cf6"];
      return cyc[i % cyc.length];
    };

    const datasets = series.map((s, i) => {
      const map = new Map(s.points.map((p) => [p.tsLabel, p.valor]));
      const isSetpoint = /setpoint/i.test(s.label);
      return {
        label: s.label,
        data: labels.map((l) => (map.has(l) ? map.get(l) : null)),
        borderColor: s.color || colorFor(s.label, i),
        backgroundColor: "transparent",
        borderWidth: isSetpoint ? 1.5 : 2,
        borderDash: isSetpoint ? [5, 4] : [],
        pointRadius: 0,
        tension: 0.35,
        spanGaps: true,
      };
    });

    const inst = new Chart(el, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top", align: "end", labels: { usePointStyle: true, pointStyle: "line", boxWidth: 22, padding: 14 } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, autoSkip: true } },
          y: { grid: { color: palette.grid }, border: { display: false }, ticks: { callback: (v) => v + "°" } },
        },
      },
    });
    instances.set(canvasId, inst);
    return inst;
  }

  return { renderEmpresas, renderTelemetria, palette };
})();
