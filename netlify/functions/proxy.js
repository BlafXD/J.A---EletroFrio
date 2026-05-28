/* netlify/functions/proxy.js
 * --------------------------------------------------------------
 * Proxy server-side para o endpoint do Galileo.
 *
 * Motivo: o host original (https://credenciamento.eletrofrio.com.br:5900)
 * está em porta não-padrão e não devolve headers CORS, então o
 * navegador bloqueia a chamada direta do front. Esta function pega
 * a chamada do front em `/api/galileo?route=...` e refaz no servidor.
 *
 * Funciona idêntica em `netlify dev` (local) e em produção.
 * Em Node 18+ (default no Netlify) `fetch` é global, sem deps.
 * --------------------------------------------------------------
 */

const TARGET = "https://credenciamento.eletrofrio.com.br:5900/galileo/api/api_hackathon";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const qs = event.queryStringParameters || {};
  const params = new URLSearchParams();
  if (qs.route) params.set("route", qs.route);
  if (qs.dispositivoId) params.set("dispositivoId", qs.dispositivoId);

  const url = `${TARGET}?${params.toString()}`;
  console.log(`[proxy] GET ${url}`);

  try {
    const upstream = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";

    return {
      statusCode: upstream.status,
      headers: {
        ...CORS,
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      },
      body: text,
    };
  } catch (err) {
    console.error("[proxy] erro", err);
    return {
      statusCode: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "upstream_failed",
        message: err.message,
        target: url,
      }),
    };
  }
};
