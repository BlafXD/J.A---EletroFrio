/* testar-gemini.mjs — confirma se a sua chave do Gemini funciona.
 * Uso (no terminal, dentro da pasta do projeto):
 *   node testar-gemini.mjs SUA_CHAVE_AQUI
 * (cole a chave AQ. ou AIza no lugar de SUA_CHAVE_AQUI)
 */
const key = process.argv[2];
if (!key) {
  console.log("Uso: node testar-gemini.mjs SUA_CHAVE_AQUI");
  process.exit(1);
}
const URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";
const body = JSON.stringify({
  contents: [{ parts: [{ text: "Responda apenas: funcionou" }] }],
  generationConfig: { maxOutputTokens: 50, thinkingConfig: { thinkingBudget: 0 } },
});

console.log("Testando a chave com o método x-goog-api-key (header)...\n");
const r = await fetch(URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": key },
  body,
});
const data = await r.json();
if (r.ok) {
  const txt = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "(resposta vazia)";
  console.log("✅ A CHAVE FUNCIONA! O Gemini respondeu:", JSON.stringify(txt));
  console.log("\nPode usar essa chave no Netlify e no .env com tranquilidade.");
} else {
  console.log("❌ A chave NÃO funcionou. Erro", r.status + ":");
  console.log("   ", data.error?.message || JSON.stringify(data));
  console.log("\nMe manda essa mensagem de erro que eu te ajudo no próximo passo.");
}
