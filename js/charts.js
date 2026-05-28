/* charts.js
 * --------------------------------------------------------------
 * Wrappers finos sobre Chart.js para manter um tema visual consistente
 * com os tokens de design. Cada função renderiza no canvas alvo e
 * retorna a instância (útil para .destroy() em re-renders).
 * --------------------------------------------------------------
 */
window.GalileoCharts = (function () {
  const palette = {
    fg: "#e7ecf2",
    muted: "#8a94a6",
    dim: "#5a6477",
    line: "#232b39",
    accent: "#76e0c8",
    critical: "#ff6b6b",
    warning: "#f5b942",
    info: "#6cb6ff",
    bg: "#10141b",
  };

  // tema global do Chart.js (aplicado uma única vez)
  let themeApplied = false;
  function applyTheme() {
    if (themeApplied || typeof Chart === "undefined") return;
    Chart.defaults.color = palette.muted;
    Chart.defaults.borderColor = palette.line;
    Chart.defaults.font.family = "JetBrains Mono, ui-monospace, monospace";
    Chart.defaults.font.size = 11;
    themeApplied = true;
  }

  // mantém referências por canvas pra fazer destroy em re-renders
  const instances = new Map();

  function destroyIfExists(canvasId) {
    const inst = instances.get(canvasId);
    if (inst) {
      inst.destroy();
      instances.delete(canvasId);
    }
  }

  function renderCriticidade(canvasId, dist) {
    applyTheme();
    destroyIfExists(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;

    const labels = Object.keys(dist).filter((k) => dist[k] > 0);
    const data = labels.map((k) => dist[k]);
    const colors = labels.map((k) => {
      if (k === "Crítica") return "#dc2626"; // vermelho mais escuro/intenso que Alta
      if (k === "Alta") return palette.critical;
      if (k === "Média") return palette.warning;
      if (k === "Baixa") return palette.info;
      if (k === "Informativa") return palette.accent;
      return palette.dim;
    });

    const inst = new Chart(el, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: colors,
            borderColor: palette.bg,
            borderWidth: 3,
            hoverOffset: 8,
          },
        ],
      },
      options: {
        cutout: "65%",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: palette.muted,
              boxWidth: 10,
              boxHeight: 10,
              padding: 12,
              font: { family: "JetBrains Mono, monospace", size: 11 },
            },
          },
          tooltip: {
            backgroundColor: palette.bg,
            borderColor: palette.line,
            borderWidth: 1,
            titleColor: palette.fg,
            bodyColor: palette.muted,
            padding: 10,
            cornerRadius: 6,
          },
        },
      },
    });
    instances.set(canvasId, inst);
    return inst;
  }

  function renderTopLojas(canvasId, top) {
    applyTheme();
    destroyIfExists(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;

    const labels = top.map((t) => t.loja);
    const data = top.map((t) => t.qtd);

    const inst = new Chart(el, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: palette.accent + "cc",
            borderColor: palette.accent,
            borderWidth: 1,
            borderRadius: 4,
            barThickness: 14,
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: palette.bg,
            borderColor: palette.line,
            borderWidth: 1,
            titleColor: palette.fg,
            bodyColor: palette.muted,
            padding: 10,
            cornerRadius: 6,
          },
        },
        scales: {
          x: {
            grid: { color: palette.line, drawBorder: false },
            ticks: { color: palette.muted, precision: 0 },
            beginAtZero: true,
          },
          y: {
            grid: { display: false },
            ticks: {
              color: palette.muted,
              callback: function (val) {
                const label = this.getLabelForValue(val);
                return label.length > 22 ? label.slice(0, 22) + "…" : label;
              },
            },
          },
        },
      },
    });
    instances.set(canvasId, inst);
    return inst;
  }

  function renderTelemetria(canvasId, seriesOrPoints, meta) {
    applyTheme();
    destroyIfExists(canvasId);
    const el = document.getElementById(canvasId);
    if (!el) return;

    // Aceita dois formatos:
    //   (a) array de séries: [{label, color, points: [{tsLabel, valor}]}]
    //   (b) array de pontos: [{ts, valor, sensor}]  (legacy / 1 linha)
    let series;
    if (
      Array.isArray(seriesOrPoints) &&
      seriesOrPoints.length > 0 &&
      Array.isArray(seriesOrPoints[0].points)
    ) {
      series = seriesOrPoints;
    } else {
      const pts = seriesOrPoints || [];
      series = pts.length
        ? [{ label: meta?.sensor || meta?.dispositivoNm || "leitura", color: null, points: pts }]
        : [];
    }

    if (!series.length || series.every((s) => !s.points.length)) {
      // canvas vazio — escreve uma mensagem discreta
      const ctx = el.getContext("2d");
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = palette.dim;
      ctx.font = "12px JetBrains Mono, monospace";
      ctx.fillText("sem leituras válidas para este dispositivo", 14, 24);
      return;
    }

    // Eixo X comum: união dos tsLabels (já vêm formatados como "HH:MM").
    // Como as séries vêm sincronizadas (mesmos labels da API), basta usar a maior.
    const longest = series.reduce(
      (best, s) => (s.points.length > best.length ? s.points : best),
      []
    );
    const labels = longest.map((p) => p.tsLabel || "");

    const fallbackColors = [palette.accent, palette.warning, palette.info, palette.critical, "#a78bfa"];

    const datasets = series.map((s, i) => {
      // mapeia points → array alinhado aos labels (preenche null onde falta)
      const valByLabel = new Map(s.points.map((p) => [p.tsLabel, p.valor]));
      const data = labels.map((lb) => (valByLabel.has(lb) ? valByLabel.get(lb) : null));
      const color = s.color || fallbackColors[i % fallbackColors.length];
      return {
        label: s.label,
        data,
        borderColor: color,
        backgroundColor: color + "22",
        borderWidth: 1.6,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        tension: 0.25,
        fill: false,
        spanGaps: true,
      };
    });

    const inst = new Chart(el, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false },
        plugins: {
          legend: {
            position: "top",
            align: "end",
            labels: {
              color: palette.muted,
              boxWidth: 10,
              boxHeight: 10,
              padding: 12,
              font: { family: "JetBrains Mono, monospace", size: 11 },
            },
          },
          tooltip: {
            backgroundColor: palette.bg,
            borderColor: palette.line,
            borderWidth: 1,
            titleColor: palette.fg,
            bodyColor: palette.muted,
            padding: 10,
            cornerRadius: 6,
          },
        },
        scales: {
          x: {
            grid: { color: palette.line, drawBorder: false },
            ticks: {
              color: palette.dim,
              maxRotation: 0,
              autoSkip: true,
              autoSkipPadding: 16,
            },
          },
          y: {
            grid: { color: palette.line, drawBorder: false },
            ticks: { color: palette.dim },
          },
        },
      },
    });
    instances.set(canvasId, inst);
    return inst;
  }

  return {
    renderCriticidade,
    renderTopLojas,
    renderTelemetria,
    palette,
  };
})();
