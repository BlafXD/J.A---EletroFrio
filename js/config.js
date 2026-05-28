/* config.js
 * --------------------------------------------------------------
 * Centraliza as rotas dos endpoints e a estratégia de transporte.
 *
 * Os endpoints originais ficam em https://credenciamento.eletrofrio.com.br:5900
 * — uma porta não-padrão que tipicamente NÃO devolve headers CORS, então
 * o navegador bloqueia chamadas diretas vindas do front.
 *
 * Solução: rota intermediária `/api/...` que é redirecionada pela
 * Netlify Function `proxy.js`. Funciona idêntica em `netlify dev` (local)
 * e em produção (Netlify).
 *
 * Para alternar entre proxy e chamada direta (caso teste com
 * extensão de CORS desabilitado), troque `USE_PROXY` para false.
 * --------------------------------------------------------------
 */
window.GALILEO_CONFIG = (function () {
  const USE_PROXY = true;

  const DIRECT_BASE = "https://credenciamento.eletrofrio.com.br:5900/galileo/api/api_hackathon";
  const PROXY_BASE = "/api/galileo";

  const base = USE_PROXY ? PROXY_BASE : DIRECT_BASE;

  return {
    USE_PROXY,
    endpoints: {
      alarmes: `${base}?route=alarmes`,
      unidades: `${base}?route=unidades`,
      telemetria: (dispositivoId) =>
        `${base}?route=telemetria&dispositivoId=${encodeURIComponent(dispositivoId)}`,
    },
    llm: {
      // Endpoint da Netlify Function que chama o Gemini 2.5 Flash.
      // A chave fica no servidor (env var GEMINI_API_KEY).
      url: "/api/llm",
      enabled: true,
      timeoutMs: 20000,
    },
    polling: {
      alarmes_ms: 5 * 60 * 1000,    // 5 min
      unidades_ms: 60 * 60 * 1000,  // 1 h
    },
    telemetria: {
      defaultDispositivoId: 13285,
      // Conforme a orientação do apresentador, descartar os 5 últimos
      // valores da série (geralmente vêm nulos / corrompidos).
      dropLastN: 5,
    },
  };
})();
