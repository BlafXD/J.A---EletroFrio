/* ============================================================
   empresa-page.js — página de uma empresa (lojas + alarmes)
   ============================================================ */
(function () {
  const api = window.GalileoAPI;
  const proc = window.GalileoProcessor;
  const analytics = window.GalileoAnalytics;
  const ui = window.GalileoUI;
  const esc = ui.escapeHTML;

  const ICON = {
    contrato: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
    pedido: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>',
    local: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>',
    fone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>',
  };

  const contaId = new URLSearchParams(location.search).get("contaId");

  function fmtData(d) {
    if (!d) return null;
    try { return new Date(d).toLocaleString("pt-BR"); } catch (e) { return null; }
  }
  function metaItem(icon, val) {
    return val ? `<span class="loja__meta-item">${icon}${esc(val)}</span>` : "";
  }
  function badge(alarmes, criticos) {
    if (criticos) return `<span class="badge badge--danger">${criticos} crítico${criticos > 1 ? "s" : ""}</span>`;
    if (!alarmes) return `<span class="badge badge--ok">OK</span>`;
    return `<span class="badge badge--warn">${alarmes} alarme${alarmes > 1 ? "s" : ""}</span>`;
  }

  function renderLoja(loja, alarmes) {
    const criticos = alarmes.filter((a) => analytics.isCritico(a)).length;
    const sinal = fmtData(loja.dhSinalVida);
    const meta = [
      metaItem(ICON.contrato, loja.tpContratoNm),
      loja.nrPedido ? metaItem(ICON.pedido, "Pedido " + loja.nrPedido) : "",
      metaItem(ICON.local, loja.endereco),
      metaItem(ICON.fone, loja.telefone),
    ].join("");

    let corpo;
    if (!alarmes.length) {
      corpo = `<div class="loja__ok">${ICON.check}Sem alarmes ativos nos últimos 30 dias.</div>`;
    } else {
      const rows = alarmes.slice(0, 8).map((a) => {
        const crit = analytics.isCritico(a);
        const sub = [a.dispositivoNm, a.criticidade, a.tempo].filter(Boolean).map(esc).join(" · ");
        return `<div class="alarme-row">
          <span class="alarme-row__dot ${crit ? "is-critico" : ""}"></span>
          <div>
            <div class="alarme-row__desc">${esc(a.alarmeDesc || a.grupoNm || "Alarme")}</div>
            ${sub ? `<div class="alarme-row__sub">${sub}</div>` : ""}
          </div>
        </div>`;
      }).join("");
      corpo = `<div class="loja__alarmes">${rows}</div>`;
    }

    return `<a class="card loja reveal" href="loja.html?lojaId=${encodeURIComponent(loja.lojaId)}">
      <div class="loja__head">
        <div class="loja__name">${esc(loja.lojaNm || "Loja " + loja.lojaId)}</div>
        ${badge(alarmes.length, criticos)}
      </div>
      ${meta ? `<div class="loja__meta">${meta}</div>` : ""}
      ${corpo}
      ${sinal ? `<div class="loja__sinal">Sinal: ${esc(sinal)}</div>` : ""}
    </a>`;
  }

  async function load() {
    const elNome = document.getElementById("emp-nome");
    const elSub = document.getElementById("emp-sub");
    const grid = document.getElementById("lojas");

    if (!contaId) {
      elNome.textContent = "Empresa não informada";
      elSub.textContent = "Volte ao dashboard e selecione uma empresa.";
      return;
    }

    try {
      const [alarmesRaw, unidadesRaw] = await Promise.all([api.getAlarmes(), api.getUnidades()]);
      const data = proc.process({ alarmesRaw, unidadesRaw, telemetriaRaw: [] });

      const lojas = data.unidades.filter((u) => String(u.contaId) === String(contaId));
      const alarmes = data.alarmes.filter((a) => String(a.contaId) === String(contaId) && a.ativo);
      const nome = lojas[0]?.contaNm || alarmes[0]?.contaNm || `Empresa ${contaId}`;

      document.title = `${nome} — Freezer Controle`;
      elNome.textContent = nome;
      elSub.textContent =
        `${lojas.length} loja${lojas.length !== 1 ? "s" : ""} · ` +
        `${alarmes.length} alarme${alarmes.length !== 1 ? "s" : ""} nos últimos 30d`;

      const porLoja = new Map();
      for (const a of alarmes) {
        if (!porLoja.has(a.lojaId)) porLoja.set(a.lojaId, []);
        porLoja.get(a.lojaId).push(a);
      }

      if (!lojas.length) {
        grid.innerHTML = '<div class="empty">Nenhuma loja encontrada para esta empresa.</div>';
        return;
      }
      // ordena: lojas com mais críticos primeiro, depois mais alarmes
      lojas.sort((a, b) => {
        const aa = porLoja.get(a.lojaId) || [], bb = porLoja.get(b.lojaId) || [];
        const ac = aa.filter((x) => analytics.isCritico(x)).length;
        const bc = bb.filter((x) => analytics.isCritico(x)).length;
        return bc - ac || bb.length - aa.length;
      });
      grid.innerHTML = lojas.map((l) => renderLoja(l, porLoja.get(l.lojaId) || [])).join("");
    } catch (e) {
      console.error("[empresa] falha:", e);
      elNome.textContent = "Falha ao carregar";
      elSub.textContent = e.message || "Tente novamente.";
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
