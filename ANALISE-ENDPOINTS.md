# Análise Técnica dos Endpoints — Galileo Watch

Documento de análise das fontes de dados da plataforma Galileo
(EletroFrio) que fundamentam o sistema. As observações abaixo foram
validadas empiricamente através de inspeção direta das respostas dos
endpoints (ver `debug.html`).

---

## 1. Representação de cada endpoint

- **`alarmes`** — ocorrências ativas ou recentes dos equipamentos
  monitorados, contendo criticidade, loja, dispositivo, descrição do
  alarme e andamento do atendimento.
- **`unidades`** — cadastro das lojas monitoradas, com dados comerciais,
  tipo de contrato, vínculo com a conta e o último sinal de vida do
  equipamento.
- **`telemetria`** — séries temporais de um dispositivo específico,
  contendo leituras de sensores e estados operacionais ao longo do tempo.
- **`abrir-chamado`** — registro formal de um atendimento/ticket para uma
  loja ou dispositivo (não consumido na versão atual; previsto no
  roadmap de integração).

## 2. Tipos de dados retornados

As respostas combinam:
- **Numéricos** — identificadores (`contaId`, `lojaId`, `dispositivoId`,
  `alarmeId`) e leituras de sensores.
- **Categóricos/textuais** — nomes, descrições, tipo de contrato,
  criticidade (codificada em letra única).
- **Datas/hora** — `alarmeDhCad`, `dtValContrato`, `dhSinalVida` (formato
  ISO 8601).
- **Nulos/opcionais** — diversos campos podem vir vazios ou ausentes,
  conforme o preenchimento na origem.

## 3. Formato dos dados

Os dados **não** são entregues em formato tabular pronto (CSV ou
relacional). O formato nativo é JSON:

- `alarmes` e `unidades` retornam **arrays de objetos** (lista de
  registros);
- `telemetria` retorna um **objeto único** no formato do Chart.js:
  `{ labels: [...], datasets: [{ label, color, values: [...] }] }`.

A conversão para estrutura tabular é feita na etapa de normalização do
sistema (`processor.js`).

## 4. Principais atributos

**Identificação**: `contaId`, `contaNm`, `lojaId`, `lojaNm`,
`lojaApelido`, `dispositivoId`, `dispositivoNm`, `alarmeId`,
`tpContratoId`, `tpContratoNm`, `nrPedido`.

**Operação/status**: `ativo`, `criticidade`, `ppAbertura`, `grupoNm`,
`subgrupoNm`, `apiTipo`, `requerTecnico`.

**Alarmes/tratamento**: `alarmeDhCad`, `alarmeDesc`, `silenciarAte`,
`eventoDhCad`, `eventoDesc`, `eventoUsu`, `tempo`, `motivoIA`.

**Contrato/unidade**: `dtValContrato`, `dhSinalVida`, `telefone`, `cnpj`,
`endereco`.

**Telemetria**: séries de sensores (temperatura ambiente, setpoint) e
estados operacionais (status de solenoide, fim de curso, relé de degelo).

## 5. Valores ausentes ou nulos

Sim, presentes em múltiplos campos. Casos confirmados: campos de evento
(`eventoDhCad`, `eventoDesc`, `eventoUsu`) frequentemente nulos em alarmes
recém-abertos; campos cadastrais (`cnpj`, `telefone`, `endereco`,
`lojaApelido`) parcialmente preenchidos; e os últimos valores das séries
de telemetria sistematicamente nulos.

## 6. Transformações aplicadas

O pipeline de tratamento (`processor.js`) executa:

1. **Coleta** — requisição aos três endpoints (via proxy, contornando o
   CORS da porta 5900).
2. **Normalização** — conversão dos arrays JSON em registros tabulares;
   padronização de datas; coerção de tipos; tratamento de nulos e espaços
   extras; mapeamento da criticidade codificada.
3. **Enriquecimento (JOIN)** — ligação entre alarmes e unidades pelas
   chaves compartilhadas (`lojaId`, `contaId`), produzindo registros
   unificados (um alarme já com contrato, vencimento e sinal de vida da
   loja).
4. **Validação** — remoção de duplicatas e descarte dos valores nulos do
   fim das séries de telemetria.

## 7. Padrões na estrutura

Sim. A maioria dos registros segue uma estrutura consistente. Variações
ocorrem entre tipos de dispositivo e no preenchimento opcional de campos,
o que exigiu uma normalização tolerante (busca de campos por múltiplos
nomes candidatos, em vez de assumir nomes fixos).

## 8. Relações entre endpoints

Sim. As chaves `lojaId`, `contaId` e `dispositivoId` permitem cruzar as
fontes. O sistema implementa o JOIN `alarmes × unidades` por `lojaId`,
que é o que viabiliza a análise contratual associada a cada alarme.

## 9. Inconsistências e tratamento

Confirmadas:
- **Espaços extras** em campos textuais (ex.: `"Afonso Pena "`,
  `" Cema Patrocínio"`, `"COMPER 99 "`) — corrigidos com `trim`.
- **Valores nulos ao final das séries de telemetria** — observados até 8
  valores nulos no final; descartados automaticamente (a orientação
  inicial era de 5; o sistema descarta a quantidade real de nulos do
  fim).
- **Criticidade codificada em letra** (`A`, `C`, `M`, `B`, `I`) —
  mapeada para rótulos legíveis.

## 10. Padrões e tendências relevantes

- IDs compartilhados que conectam as fontes (base do enriquecimento).
- Concentração de alarmes em determinadas lojas (visível no ranking
  Top-10).
- Predominância de alarmes de temperatura no grupo "Ambiente".
- Valores nulos recorrentes no fim das séries temporais.

## 11. Anomalias identificadas

- Inconsistência de espaçamento em `lojaNm` (espaços à esquerda/direita).
- Cauda de valores nulos nas séries de telemetria, provavelmente
  decorrente de leituras ainda não consolidadas no momento da consulta.

## 12. Hipóteses

Unidades com contrato próximo do vencimento tendem a apresentar maior
incidência de alarmes, sugerindo correlação entre risco contratual e
risco operacional. O sistema testa essa hipótese cruzando
`dtValContrato` com a contagem de alarmes ativos por loja.

## 13. Decisões suportadas pelos dados

- Priorização de atendimento por criticidade e impacto contratual.
- Identificação de unidades sem sinal de vida (risco de comunicação).
- Antecipação de renovações contratuais em unidades com alta incidência
  de alarmes.
- Notificação imediata de ocorrências críticas ao responsável.

## 14. Melhorias propostas para a API

- Disponibilização de cabeçalhos CORS (hoje exige proxy server-side).
- Padronização do formato de saída entre endpoints (telemetria usa
  estrutura distinta das demais).
- Inclusão explícita do fuso horário nos campos de data.
- Documentação dos códigos de criticidade e demais enumerações.

## 15. Informações adicionais desejáveis

- Dicionário de dados oficial (descrição de cada campo e enumeração).
- Histórico de alarmes (o endpoint atual reflete o estado corrente).
- Metadados de cada série de telemetria (unidade de medida, faixa
  esperada por tipo de dispositivo) para parametrizar a detecção de
  anomalias.
