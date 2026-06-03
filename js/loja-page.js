/* ============================================================
   loja-page.js — painel individual da loja (telemetria + o que houve)
   O diagnóstico aqui é 100% factual (baseado nas leituras reais),
   nunca inventa nada: descreve o que a telemetria mostra ou diz que
   não há leitura. Mesma lógica do diagnóstico do backend.
   ============================================================ */
(function () {
  const api = window.GalileoAPI;
  const proc = window.GalileoProcessor;
  const analytics = window.GalileoAnalytics;
  const charts = window.GalileoCharts;
  const ui = window.GalileoUI;
  const esc = ui.escapeHTML;

  const ICON = {
    contrato: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    pedido: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>',
    local: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
    fone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  };

  const lojaId = new URLSearchParams(location.search).get("lojaId");

  /* ---------- análise factual da telemetria ---------- */
  function statSerie(points) {
    const vals = points.map((p) => p.valor).filter((v) => v != null && !isNaN(v));
    if (!vals.length) return null;
    const atual = vals[vals.length - 1];
    const min = Math.min(...vals), max = Math.max(...vals);
    const media = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
    const ult = vals.slice(-6), ant = vals.slice(-12, -6);
    let tendencia = "estável";
    if (ult.length >= 3 && ant.length >= 3) {
      const d = (ult.reduce((a, b) => a + b, 0) / ult.length) - (ant.reduce((a, b) => a + b, 0) / ant.length);
      if (d > 0.5) tendencia = "subindo"; else if (d < -0.5) tendencia = "descendo";
    }
    return { atual, min, max, media, tendencia, n: vals.length };
  }

  function analisar(series) {
    if (!series || !series.length) return null;
    const tempS = series.find((s) => /temperatura\s*ambiente/i.test(s.label)) ||
                  series.find((s) => /temperatura/i.test(s.label) && !/degelo|suc|evap/i.test(s.label));
    const spS = series.find((s) => /setpoint/i.test(s.label));
    const temp = tempS ? Object.assign({ label: tempS.label }, statSerie(tempS.points)) : null;
    const setpoint = spS ? Object.assign({ label: spS.label }, statSerie(spS.points)) : null;
    let desvioAtual = null, acimaSetpoint = null, minutosAcima = null;
    if (temp && setpoint && temp.atual != null && setpoint.atual != null) {
      desvioAtual = +(temp.atual - setpoint.atual).toFixed(1);
      acimaSetpoint = desvioAtual > 0.5;
      const spMap = new Map(spS.points.map((p) => [p.tsLabel, p.valor]));
      let cont = 0;
      for (let i = tempS.points.length - 1; i >= 0; i--) {
        const tp = tempS.points[i];
        const sp = spMap.has(tp.tsLabel) ? spMap.get(tp.tsLabel) : setpoint.atual;
        if (sp != null && tp.valor - sp > 0.5) cont++; else break;
      }
      if (cont > 0) minutosAcima = cont * 5;
    }
    return { temp, setpoint, desvioAtual, acimaSetpoint, minutosAcima };
  }

  function causaProvavel(txt) {
    const t = (txt || "").toLowerCase();
    if (/degelo/.test(t)) return "ciclo de degelo prolongado ou resistência de degelo travada";
    if (/compressor/.test(t)) return "falha, desarme ou sobrecarga do compressor";
    if (/comunica|sinal|offline|conex/.test(t)) return "perda de comunicação do controlador (não necessariamente falha de refrigeração)";
    if (/porta/.test(t)) return "porta aberta por tempo excessivo ou vedação comprometida";
    if (/aliment|energia|tens[aã]o/.test(t)) return "falha de alimentação elétrica do equipamento";
    if (/alta|temperatura/.test(t)) return "porta aberta, condensador sujo, degelo travado ou falha no compressor";
    return "falha no sistema de refrigeração do equipamento";
  }

  function diagnostico(txtAlarme, a) {
    const partes = [];
    if (a && a.temp && a.temp.atual != null) {
      let s = `Temperatura atual de <b>${a.temp.atual}°C</b>`;
      if (a.setpoint && a.setpoint.atual != null) {
        if (a.acimaSetpoint) {
          s += `, <b>${Math.abs(a.desvioAtual)}°C acima</b> do setpoint (${a.setpoint.atual}°C)`;
          if (a.minutosAcima) s += `, há ~${a.minutosAcima} min`;
        } else { s += `, dentro da faixa do setpoint (${a.setpoint.atual}°C)`; }
      }
      s += ".";
      if (a.temp.tendencia && a.temp.tendencia !== "estável") s += ` Tendência <b>${a.temp.tendencia}</b>.`;
      partes.push(s);
      if (a.acimaSetpoint) {
        const grave = (a.minutosAcima && a.minutosAcima >= 30) || (a.desvioAtual && a.desvioAtual >= 5);
        if (grave) partes.push("Desvio elevado/prolongado — risco à conservação dos produtos.");
        partes.push("Causas prováveis: " + causaProvavel(txtAlarme) + ".");
      } else { partes.push("Equipamento sob controle no momento; acompanhar as próximas leituras."); }
    } else {
      partes.push("Sem leitura de telemetria recente para este equipamento. Verifique a comunicação do controlador.");
    }
    return partes.join(" ");
  }

  /* ---------- render ---------- */
  function fmtData(d) { if (!d) return null; try { return new Date(d).toLocaleString("pt-BR"); } catch (e) { return null; } }

  function renderMeta(loja) {
    const item = (icon, v) => (v ? `<span class="loja__meta-item">${icon}${esc(v)}</span>` : "");
    const sinal = fmtData(loja.dhSinalVida);
    document.getElementById("loja-meta").innerHTML =
      item(ICON.contrato, loja.tpContratoNm) +
      (loja.nrPedido ? item(ICON.pedido, "Pedido " + loja.nrPedido) : "") +
      item(ICON.local, loja.endereco) +
      item(ICON.fone, loja.telefone) +
      (sinal ? item(ICON.clock, "Sinal: " + sinal) : "");
  }

  function dispCardHTML(d) {
    const criticos = d.alarmes.filter((a) => analytics.isCritico(a)).length;
    const bdg = criticos
      ? `<span class="badge badge--danger">${criticos} crítico${criticos > 1 ? "s" : ""}</span>`
      : `<span class="badge badge--warn">${d.alarmes.length} alarme${d.alarmes.length > 1 ? "s" : ""}</span>`;
    const alarmesHTML = d.alarmes.slice(0, 6).map((a) => {
      const crit = analytics.isCritico(a);
      const sub = [a.criticidade, a.tempo].filter(Boolean).map(esc).join(" · ");
      return `<div class="alarme-row"><span class="alarme-row__dot ${crit ? "is-critico" : ""}"></span><div><div class="alarme-row__desc">${esc(a.alarmeDesc || a.grupoNm || "Alarme")}</div>${sub ? `<div class="alarme-row__sub">${sub}</div>` : ""}</div></div>`;
    }).join("");
    return `<div class="card disp reveal" id="disp-${esc(d.dispositivoId)}">
      <div class="disp__head">
        <div class="disp__name">${esc(d.dispositivoNm || "Dispositivo " + d.dispositivoId)}</div>
        ${bdg}
      </div>
      <div class="disp__diag" id="diag-${esc(d.dispositivoId)}">Analisando telemetria…</div>
      <div class="disp__stats" id="stats-${esc(d.dispositivoId)}"></div>
      <div class="disp__chart-wrap"><div class="chart-box chart-box--sm"><canvas id="tel-${esc(d.dispositivoId)}"></canvas></div></div>
      <div class="disp__alarmes">${alarmesHTML}</div>
    </div>`;
  }

  async function carregarTelemetria(d) {
    const txtAlarme = [d.alarmePrincipal && d.alarmePrincipal.alarmeDesc, d.alarmePrincipal && d.alarmePrincipal.grupoNm, d.alarmePrincipal && d.alarmePrincipal.subgrupoNm].filter(Boolean).join(" ");
    const diagEl = document.getElementById(`diag-${d.dispositivoId}`);
    const statsEl = document.getElementById(`stats-${d.dispositivoId}`);
    const wrap = document.querySelector(`#disp-${d.dispositivoId} .disp__chart-wrap`);
    try {
      const raw = await api.getTelemetria(d.dispositivoId);
      const data = proc.process({ alarmesRaw: [], unidadesRaw: [], telemetriaRaw: raw });
      const series = data.telemetriaSeries || [];
      if (!series.length || !series.some((s) => s.points.length)) {
        if (wrap) wrap.innerHTML = '<div class="disp__chart-empty">Sem telemetria recente para este equipamento.</div>';
      } else {
        charts.renderTelemetria(`tel-${d.dispositivoId}`, series);
      }
      const a = analisar(series);
      if (diagEl) {
        diagEl.innerHTML = diagnostico(txtAlarme, a);
        if (a && a.acimaSetpoint) diagEl.classList.add("is-alerta");
      }
      if (statsEl && a && a.temp) {
        const chips = [];
        if (a.temp.atual != null) chips.push(`<div class="stat-chip"><span class="stat-chip__label">Atual</span><span class="stat-chip__value ${a.acimaSetpoint ? "is-danger" : "is-ok"}">${a.temp.atual}°C</span></div>`);
        if (a.setpoint && a.setpoint.atual != null) chips.push(`<div class="stat-chip"><span class="stat-chip__label">Setpoint</span><span class="stat-chip__value">${a.setpoint.atual}°C</span></div>`);
        if (a.temp.media != null) chips.push(`<div class="stat-chip"><span class="stat-chip__label">Média</span><span class="stat-chip__value">${a.temp.media}°C</span></div>`);
        if (a.temp.tendencia) chips.push(`<div class="stat-chip"><span class="stat-chip__label">Tendência</span><span class="stat-chip__value">${a.temp.tendencia}</span></div>`);
        statsEl.innerHTML = chips.join("");
      }
    } catch (e) {
      console.error("[loja] telemetria falhou p/", d.dispositivoId, e.message);
      if (diagEl) diagEl.textContent = "Não foi possível carregar a telemetria deste equipamento.";
      if (wrap) wrap.innerHTML = '<div class="disp__chart-empty">Telemetria indisponível.</div>';
    }
  }

  async function load() {
    const elNome = document.getElementById("loja-nome");
    const elSub = document.getElementById("loja-sub");
    const grid = document.getElementById("dispositivos");

    if (!lojaId) {
      elNome.textContent = "Loja não informada";
      elSub.textContent = "Acesse pelo dashboard ou pelo link do alerta.";
      grid.innerHTML = "";
      return;
    }

    try {
      const [alarmesRaw, unidadesRaw] = await Promise.all([api.getAlarmes(), api.getUnidades()]);
      const data = proc.process({ alarmesRaw, unidadesRaw, telemetriaRaw: [] });

      const loja = data.unidades.find((u) => String(u.lojaId) === String(lojaId));
      const alarmes = data.alarmes.filter((a) => String(a.lojaId) === String(lojaId) && a.ativo);

      const nome = (loja && loja.lojaNm) || (alarmes[0] && alarmes[0].lojaNm) || `Loja ${lojaId}`;
      const empresa = (loja && loja.contaNm) || (alarmes[0] && alarmes[0].contaNm) || "";
      document.title = `${nome} — Freezer Controle`;
      elNome.textContent = nome;

      const contaId = (loja && loja.contaId) || (alarmes[0] && alarmes[0].contaId);
      if (contaId) document.getElementById("back-link").href = `empresa.html?contaId=${encodeURIComponent(contaId)}`;

      if (loja) renderMeta(loja);

      const m = new Map();
      for (const a of alarmes) {
        if (!a.dispositivoId) continue;
        if (!m.has(a.dispositivoId)) m.set(a.dispositivoId, { dispositivoId: a.dispositivoId, dispositivoNm: a.dispositivoNm, alarmes: [], alarmePrincipal: a });
        const e = m.get(a.dispositivoId);
        e.alarmes.push(a);
        if (analytics.isCritico(a) && !analytics.isCritico(e.alarmePrincipal)) e.alarmePrincipal = a;
      }
      const dispositivos = [...m.values()].sort((x, y) => y.alarmes.length - x.alarmes.length);

      elSub.textContent = `${empresa ? empresa + " · " : ""}${dispositivos.length} equipamento${dispositivos.length !== 1 ? "s" : ""} com alarme nos últimos 30d`;

      if (!dispositivos.length) {
        grid.innerHTML = '<div class="empty">Nenhum equipamento com alarmes ativos nos últimos 30 dias para esta loja. 🎉</div>';
        return;
      }
      grid.innerHTML = dispositivos.map(dispCardHTML).join("");
      dispositivos.forEach(carregarTelemetria);
    } catch (e) {
      console.error("[loja] falha:", e);
      elNome.textContent = "Falha ao carregar";
      elSub.textContent = e.message || "Tente novamente.";
      grid.innerHTML = "";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
