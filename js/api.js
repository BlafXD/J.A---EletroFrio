/* api.js
 * --------------------------------------------------------------
 * Camada fina sobre fetch() para os três endpoints do Galileo.
 * Sempre retorna o JSON cru; o tratamento e enriquecimento
 * acontecem em processor.js — assim os papéis ficam separados.
 * --------------------------------------------------------------
 */
window.GalileoAPI = (function (cfg) {
  async function fetchJSON(url, label) {
    const startedAt = performance.now();
    let res;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (e) {
      throw new Error(
        `[${label}] falha de rede: ${e.message}. ` +
          `Se estiver rodando em http://localhost sem 'netlify dev', ` +
          `o proxy CORS não está ativo.`
      );
    }

    if (!res.ok) {
      throw new Error(`[${label}] HTTP ${res.status} ${res.statusText}`);
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(`[${label}] resposta não é JSON válido`);
    }

    const elapsed = (performance.now() - startedAt).toFixed(0);
    console.info(`[api] ${label} ok · ${elapsed}ms · ${Array.isArray(json) ? json.length : "obj"} reg`);

    // log de debug: mostra as chaves e o primeiro item — útil pra ajustar
    // o processor caso os nomes dos campos sejam diferentes do esperado.
    if (Array.isArray(json) && json.length > 0) {
      const keys = Object.keys(json[0]);
      console.groupCollapsed(`[api] ${label} · chaves do 1º item (${keys.length})`);
      console.log("keys:", keys);
      console.log("primeiro item:", json[0]);
      console.groupEnd();
    }

    return json;
  }

  return {
    getAlarmes() {
      return fetchJSON(cfg.endpoints.alarmes, "alarmes");
    },
    getUnidades() {
      return fetchJSON(cfg.endpoints.unidades, "unidades");
    },
    getTelemetria(dispositivoId) {
      const id = dispositivoId || cfg.telemetria.defaultDispositivoId;
      return fetchJSON(cfg.endpoints.telemetria(id), `telemetria(${id})`);
    },
  };
})(window.GALILEO_CONFIG);
