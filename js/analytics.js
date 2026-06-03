/* analytics.js
 * --------------------------------------------------------------
 * Agregações em memória usadas pelos KPIs, charts e pelo RAG.
 *
 * Não persiste em SGBD — para a PoC, o "banco" é o array tratado
 * em memória. Em produção esta camada seria substituída por queries
 * num Postgres + Redis cache. As assinaturas das funções foram
 * pensadas para sobreviverem à troca: entram listas, saem números/
 * agregações, tudo puro.
 * --------------------------------------------------------------
 */
window.GalileoAnalytics = (function () {
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  function isAtivo(a) {
    return a.ativo === true;
  }

  function kpiTotalAtivos(alarmes) {
    return alarmes.filter(isAtivo).length;
  }

  function kpiCriticos(alarmes) {
    // Conta Alta + Crítica — ambas são severidades graves no mapeamento
    // do Galileo (C = Crítica é o nível máximo, acima de A = Alta).
    return alarmes.filter(
      (a) => isAtivo(a) && (a.criticidade === "Alta" || a.criticidade === "Crítica")
    ).length;
  }

  function kpiUnidades(unidades) {
    return unidades.length;
  }

  function kpiSinalVida24h(unidades, ref = new Date()) {
    return unidades.filter((u) => {
      if (!u.dhSinalVida) return false;
      return ref.getTime() - u.dhSinalVida.getTime() <= DAY_MS;
    }).length;
  }

  function kpiContratosVencendo(unidades, dias = 30, ref = new Date()) {
    const limite = ref.getTime() + dias * DAY_MS;
    return unidades.filter((u) => {
      if (!u.dtValContrato) return false;
      const t = u.dtValContrato.getTime();
      return t >= ref.getTime() && t <= limite;
    }).length;
  }

  /* ---------- agregações para gráficos ---------- */
  function porCriticidade(alarmes) {
    const buckets = {
      "Crítica": 0,
      Alta: 0,
      "Média": 0,
      Baixa: 0,
      Informativa: 0,
      "Sem classificação": 0,
    };
    for (const a of alarmes) {
      if (!isAtivo(a)) continue;
      const k = a.criticidade || "Sem classificação";
      buckets[k] = (buckets[k] || 0) + 1;
    }
    return buckets;
  }

  function topLojasPorAlarmes(alarmes, n = 10) {
    const map = new Map();
    for (const a of alarmes) {
      if (!isAtivo(a)) continue;
      const nome = a.lojaApelido || a.lojaNm || `loja#${a.lojaId}` || "desconhecida";
      map.set(nome, (map.get(nome) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([loja, qtd]) => ({ loja, qtd }));
  }

  function semSinalVida(unidades, horas = 24, ref = new Date()) {
    const limite = ref.getTime() - horas * HOUR_MS;
    return unidades
      .filter((u) => !u.dhSinalVida || u.dhSinalVida.getTime() < limite)
      .map((u) => ({
        loja: u.lojaApelido || u.lojaNm || `loja#${u.lojaId}`,
        ultimo_sinal: u.dhSinalVida,
        horas_sem_sinal: u.dhSinalVida
          ? Math.round((ref.getTime() - u.dhSinalVida.getTime()) / HOUR_MS)
          : null,
      }));
  }

  function statsTelemetria(serie) {
    if (!serie || !serie.length) return null;
    const valores = serie.map((p) => p.valor).filter((v) => v !== null);
    if (!valores.length) return null;
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    const sum = valores.reduce((s, v) => s + v, 0);
    const avg = sum / valores.length;
    return {
      n: valores.length,
      min,
      max,
      avg: Number(avg.toFixed(2)),
      ultima: serie[serie.length - 1],
    };
  }

  function contratosComMaisAlarmes(alarmes, unidades, n = 5) {
    // Hipótese formulada: unidades com contrato próximo do vencimento
    // tendem a ter mais alarmes. Testamos isso aqui.
    const ref = new Date();
    const limiteVenc = ref.getTime() + 60 * DAY_MS;

    const alarmesPorLoja = new Map();
    for (const a of alarmes) {
      if (!isAtivo(a) || !a.lojaId) continue;
      const k = String(a.lojaId);
      alarmesPorLoja.set(k, (alarmesPorLoja.get(k) || 0) + 1);
    }

    return unidades
      .filter(
        (u) =>
          u.dtValContrato &&
          u.dtValContrato.getTime() <= limiteVenc &&
          u.dtValContrato.getTime() >= ref.getTime()
      )
      .map((u) => ({
        loja: u.lojaApelido || u.lojaNm,
        contrato: u.tpContratoNm,
        vence_em_dias: Math.round((u.dtValContrato.getTime() - ref.getTime()) / DAY_MS),
        alarmes_ativos: alarmesPorLoja.get(String(u.lojaId)) || 0,
      }))
      .sort((a, b) => b.alarmes_ativos - a.alarmes_ativos)
      .slice(0, n);
  }

  function formatTempoAberto(dhCad, ref = new Date()) {
    if (!dhCad) return "—";
    const diff = ref.getTime() - dhCad.getTime();
    if (diff < 0) return "no futuro";
    const min = Math.floor(diff / 60000);
    if (min < 1) return "agora";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ${min % 60}min`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }

  /* ---------- agrupamento por empresa (visão do dashboard) ---------- */
  function isCritico(a) {
    return a.criticidade === "Alta" || a.criticidade === "Crítica";
  }

  // Agrupa por contaId, semeando com as unidades (assim toda empresa com loja
  // aparece, mesmo sem alarme) e somando alarmes/críticos por cima.
  function porEmpresa(alarmes, unidades) {
    const byConta = new Map();
    for (const u of unidades) {
      const id = u.contaId;
      if (id == null || id === "") continue;
      if (!byConta.has(id)) {
        byConta.set(id, { contaId: id, contaNm: u.contaNm || `Conta ${id}`, lojas: [], alarmes: 0, criticos: 0 });
      }
      byConta.get(id).lojas.push(u);
    }
    for (const a of alarmes) {
      if (!isAtivo(a)) continue;
      const id = a.contaId;
      if (id == null || id === "") continue;
      if (!byConta.has(id)) {
        byConta.set(id, { contaId: id, contaNm: a.contaNm || `Conta ${id}`, lojas: [], alarmes: 0, criticos: 0 });
      }
      const e = byConta.get(id);
      e.alarmes++;
      if (isCritico(a)) e.criticos++;
    }
    return [...byConta.values()].sort((a, b) => String(a.contaNm).localeCompare(String(b.contaNm)));
  }

  function totaisGerais(empresas) {
    return {
      empresas: empresas.length,
      lojas: empresas.reduce((s, e) => s + e.lojas.length, 0),
      alarmes: empresas.reduce((s, e) => s + e.alarmes, 0),
      criticos: empresas.reduce((s, e) => s + e.criticos, 0),
    };
  }

  function topEmpresasAlarmes(empresas, n = 8) {
    return [...empresas]
      .filter((e) => e.alarmes > 0)
      .sort((a, b) => b.alarmes - a.alarmes)
      .slice(0, n);
  }

  return {
    kpiTotalAtivos,
    kpiCriticos,
    porEmpresa,
    totaisGerais,
    topEmpresasAlarmes,
    isCritico,
    kpiUnidades,
    kpiSinalVida24h,
    kpiContratosVencendo,
    porCriticidade,
    topLojasPorAlarmes,
    semSinalVida,
    statsTelemetria,
    contratosComMaisAlarmes,
    formatTempoAberto,
  };
})();
