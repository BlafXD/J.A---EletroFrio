# Galileo Watch — PoC de Previsão de Falhas e Gestão Contratual

> Console de monitoramento e suporte à decisão para uma rede de
> supermercados com equipamentos de refrigeração monitorados pela
> plataforma Galileo da EletroFrio. Consome alarmes, unidades e
> telemetria em tempo real, cruza-os e expõe a operação através de
> indicadores, gráficos e uma camada de consulta em linguagem natural.

**Site em produção**: https://radiant-sunburst-1294db.netlify.app/
**Deploy preview**: https://6a0a1f819a99dc9cdd71ed7b--radiant-sunburst-1294db.netlify.app/
**Página de debug** (estrutura crua dos endpoints): https://radiant-sunburst-1294db.netlify.app/debug.html

---

## Contexto e problema

A operação de refrigeração comercial é silenciosa quando funciona e
catastrófica quando falha. Câmaras frigoríficas, expositores e ilhas
de congelados de um supermercado armazenam centenas de milhares de
reais em produto perecível, e a janela de tolerância entre "alarme
disparado" e "produto perdido" pode ser de poucas horas — às vezes
minutos para itens como sorvete e açougue.

A plataforma Galileo já entrega dados ricos sobre essa operação:
ocorrências em tempo real, cadastro contratual das unidades e séries
temporais por dispositivo. O problema é que esses dados chegam em
**três endpoints heterogêneos, sem correlação direta no momento da
entrega**, sendo difícil para um operador responder em segundos a
perguntas como:

- "Quais lojas têm alarmes graves agora e qual o impacto contratual
  delas?"
- "Existem dispositivos sinalizando comportamento anômalo antes do
  alarme oficial?"
- "Quais contratos estão a vencer **e** apresentam histórico de
  alarmes recentes?"

## Questão de pesquisa

> Como antecipar falhas em equipamentos de refrigeração monitorados e
> priorizar intervenções considerando o contexto contratual de cada
> unidade, reduzindo perda de produto perecível e tempo de
> indisponibilidade?

## Objetivo geral

Desenvolver uma solução de monitoramento e suporte à decisão que
unifique os dados operacionais e contratuais da plataforma Galileo,
permitindo a antecipação de falhas, a identificação de anomalias em
telemetria e a priorização de intervenções com base no risco real
para o negócio.

## Objetivos específicos

1. **Previsão de Falhas** — antecipar a ocorrência de falhas em
   equipamentos de refrigeração analisando o comportamento histórico
   recente de variáveis críticas (temperatura ambiente, setpoint,
   acionamentos de degelo) e identificando padrões precursores antes
   do disparo do alarme oficial.

2. **Identificação de Anomalias** — detectar desvios de comportamento
   em séries temporais de telemetria que fujam da operação normal de
   cada dispositivo (drift de setpoint, oscilação fora da banda
   estatística, períodos prolongados sem sinal de vida) e sinalizá-los
   visualmente para o operador.

3. **Priorização Inteligente de Intervenções** — combinar criticidade
   do alarme, janela de vencimento contratual e tempo desde o último
   sinal de vida em um score único de risco por loja, produzindo um
   ranking objetivo de onde a operação deve agir primeiro, em vez de
   tratar todos os alarmes com igual prioridade.

## Justificativa

A indisponibilidade de equipamentos de refrigeração em um
supermercado tem três custos diretos sobrepostos:

- **Perda de produto** — perecíveis (cárneos, laticínios, congelados,
  hortifrúti) descartados quando a cadeia do frio é rompida. Em uma
  câmara de médio porte, isso pode ultrapassar dezenas de milhares de
  reais em poucas horas.
- **Risco sanitário e regulatório** — produtos vendidos fora da curva
  de temperatura adequada expõem o consumidor e a rede a sanções da
  Vigilância Sanitária.
- **Custo operacional reativo** — atendimento técnico de emergência é
  significativamente mais caro do que manutenção planejada.

Reduzir, ainda que marginalmente, o tempo entre o início de uma
anomalia e a intervenção qualificada, ou antecipar uma falha pela
leitura de seus precursores, gera retorno mensurável. É nesse vão que
esta PoC atua: transformar dado bruto da plataforma em **ação
priorizada**.

## Contexto de aplicação

A solução foi desenhada para uso em **centros de operação (NOC) ou
equipes de monitoramento remoto** que acompanham várias unidades em
paralelo. Os usuários típicos são:

- **Operadores de monitoramento** — precisam de um painel onde
  identifiquem em segundos onde há fogo;
- **Coordenadores comerciais** — precisam cruzar a saúde operacional
  com a janela contratual para conversar com o cliente;
- **Equipes técnicas de campo** — precisam de priorização clara para
  rotear deslocamentos.

A interface foi pensada para uso primário em desktop de NOC (1080p+)
e suporta navegação em tablets e celulares.

---

## Cobertura dos requisitos mínimos da PoC

| Requisito                                                              | Onde está implementado |
|---|---|
| Consumo funcional de pelo menos um endpoint                            | `js/api.js` — consome os três (alarmes, unidades, telemetria) em paralelo |
| Organização ou tratamento básico dos dados                             | `js/processor.js` — normalização, dedupe, parse de datas e números, descarte automático de nulos do fim da série, JOIN alarmes × unidades |
| Interface funcional                                                    | `index.html` + CSS modular em 4 arquivos, responsiva em 3 breakpoints |
| Pelo menos uma visualização, painel ou indicador                       | 5 KPIs + donut de criticidade + bar chart top-10 lojas + line chart multi-série de telemetria + tabela enriquecida |
| Análise/interpretação relacionada à proposta do grupo                  | `js/rag.js` — chunking + TF-IDF cosseno + síntese; correlação contratos × alarmes; ranking de lojas críticas |

## Coerência problema → solução

| Eixo                          | Implementação |
|---|---|
| **Problema definido**         | Falta de visão unificada e priorizada da saúde operacional vs contratual |
| **Objetivos estabelecidos**   | Previsão, identificação de anomalias e priorização inteligente |
| **Dados disponíveis**         | Três endpoints da plataforma Galileo, conferidos em `debug.html` |
| **Funcionalidades implementadas** | Ingestão, tratamento, dashboard, RAG e cruzamento contratual |
| **Solução proposta**          | Console operacional + camada de consulta em linguagem natural |

---

## Estrutura do projeto

```
ProjetoFinal/
├── index.html                  estrutura do dashboard
├── debug.html                  página técnica que mostra o JSON cru dos 3 endpoints
├── css/
│   ├── reset.css
│   ├── tokens.css              variáveis de design (cores, tipografia)
│   ├── layout.css              topbar, grid, footer, breakpoints
│   └── components.css          kpis, painéis, tabela, tags, RAG
├── js/
│   ├── config.js               base URL e parâmetros de polling
│   ├── api.js                  cliente fetch dos 3 endpoints
│   ├── processor.js            normalização, dedupe, enriquecimento (JOIN)
│   ├── analytics.js            agregações para KPIs e charts
│   ├── charts.js               wrappers Chart.js com tema dark
│   ├── rag.js                  chunking + TF-IDF + síntese
│   ├── ui.js                   renderização do DOM
│   └── main.js                 orquestrador
├── netlify/
│   └── functions/
│       ├── proxy.js            proxy server-side para os endpoints Galileo (CORS)
│       └── llm.js              chama o Gemini 2.5 Flash com a chave do env
├── netlify.toml                build, functions e redirects
├── .gitignore                  ignora .netlify/ e .env (cache + segredos locais)
└── README.md
```

---

## Por que existe um proxy

Os endpoints originais estão em
`https://credenciamento.eletrofrio.com.br:5900` — porta não-padrão e
sem headers CORS. Chamadas diretas do navegador são bloqueadas.

A `netlify/functions/proxy.js` repassa a chamada do lado do servidor
(onde CORS não existe) e devolve com `Access-Control-Allow-Origin: *`.

No front, o `config.js` aponta para `/api/galileo?route=...`, e o
`netlify.toml` redireciona esse path para a function. Ou seja:
**o front nunca chama o host original diretamente**.

---

## Executando localmente (VSCode)

A forma recomendada usa a Netlify CLI porque ela carrega as functions
e os redirects do `netlify.toml` localmente — exatamente como em
produção.

```bash
# uma vez só
npm install -g netlify-cli

# na raiz do projeto
netlify dev
```

A CLI abre o site (em `http://localhost:8888`) e expõe `/api/galileo`
redirecionando para a function.

### Variável de ambiente para o Gemini

A function `/api/llm` lê a chave do Gemini em `process.env.GEMINI_API_KEY`.

- **Em produção** (Netlify): configurada via *Site settings → Environment
  variables*. Já está configurada no deploy atual.
- **Em desenvolvimento local**: crie um arquivo `.env` na raiz do projeto:

  ```
  GEMINI_API_KEY=sua-chave-aqui
  ```

  O `.gitignore` já ignora esse arquivo. **Nunca commite essa chave.**

  O `netlify dev` lê o `.env` automaticamente e injeta como `process.env`
  na function local.

> **Sem `netlify dev`**, o fetch falha por CORS — abrir o `index.html`
> direto no Live Server mostra a interface mas não carrega dados.

> **Sem `GEMINI_API_KEY`**, o RAG cai automaticamente para o motor de
> regras pré-programadas (fallback). O sistema continua funcional, só
> não usa o LLM.

---

## Deploy no Netlify

1. Suba o repositório no GitHub.
2. No painel do Netlify, **Add new site → Import from Git**, escolha
   o repo.
3. Em **Build settings**, deixe **Publish directory = `.`** (raiz).
   Não há comando de build necessário — o `netlify.toml` já define
   `functions = "netlify/functions"` e o bundler.
4. Deploy. A function `proxy` é detectada automaticamente.

A URL pública servirá o dashboard e o proxy no mesmo domínio.

---

## Funcionalidades atuais (versão da PoC)

### Ingestão e tratamento
- Polling paralelo dos três endpoints na carga inicial
- Trim em strings (resolve `"Afonso Pena "`, `" Cema Patrocínio"`)
- Parse robusto de datas (ISO e formato brasileiro)
- Aceita vírgula como separador decimal
- Mapeamento de criticidade da API (`A` → Alta, `C` → Crítica,
  `M` → Média, `B` → Baixa, `I` → Informativa)
- Descarte automático dos valores `null` no fim das séries
- Dedupe por `alarmeId` e por `lojaId+contaId`

### Visualizações
- **5 KPIs**: alarmes ativos, criticidade alta+crítica, unidades
  cadastradas, sinal de vida nas últimas 24h, contratos a vencer em
  30 dias
- **Donut de criticidade**: distribuição dos alarmes ativos
- **Bar chart**: top-10 lojas por volume de alarmes
- **Line chart multi-série**: até 5 séries paralelas de telemetria
  (Temperatura Ambiente, Setpoint, Status Solenoide, Fim de Curso,
  Relé de Degelo), com as cores fornecidas pela própria API
- **Tabela enriquecida**: alarmes ativos com loja, dispositivo,
  descrição, criticidade colorida, tempo aberto, contrato e último
  sinal de vida

### Consulta inteligente (RAG)
- **Retrieval**: chunking textual a partir dos dados estruturados + TF-IDF cosseno
- **Generation**: chama o **Gemini 2.5 Flash** via Netlify Function `/api/llm` (a chave
  `GEMINI_API_KEY` fica em variável de ambiente, nunca no client)
- **Fallback determinístico**: se o LLM falhar (rede, quota, erro 5xx), o sistema
  recai automaticamente para regras pré-programadas, garantindo que o operador
  sempre receba uma resposta
- Badge na resposta indica a origem (`via gemini-2.5-flash` ou `via regras (fallback)`)
- Cada resposta exibe os chunks-fonte com seu score de similaridade
- 4 atalhos pré-configurados (chips)

---

## Ideias de evolução

As próximas iterações se concentram em dar densidade analítica ao
console, mantendo o foco em **Previsão de Falhas** e **Gestão
Contratual**:

### 1. Score de risco por loja
Combinar `#alarmes ativos × peso da criticidade + dias até vencimento
contratual + horas sem sinal de vida` num número de 0 a 100 por loja.
Substituiria parcialmente o "top lojas por volume" por um "top lojas
por risco" — mais útil pra triagem do operador. As peças já estão
todas em `analytics.js`.

### 2. Detecção de outlier em telemetria
Janela móvel sobre Temperatura Ambiente: marca visualmente no gráfico
os pontos que ultrapassam média ± 2 desvios-padrão da janela recente.
Sinaliza anomalias antes que virem alarmes oficiais — atende
diretamente o objetivo específico 2 (**Identificação de Anomalias**).

### 3. Drift de setpoint
Alerta precoce quando `Temperatura Ambiente − Setpoint > X°C` por N
leituras consecutivas. É o sinal clássico de problema mecânico
(compressor com folga, gás baixo, degelo travado) **antes** de o
alarme de alta temperatura disparar — atende o objetivo específico 1
(**Previsão de Falhas**).

### 4. Funil de risco contratual
Bucketing dos contratos a vencer em 7 / 15 / 30 / 60 dias mostrando
quantos alarmes ativos cada bucket carrega. Visualização direta da
correlação operacional-contratual — atende o objetivo específico 3
(**Priorização Inteligente de Intervenções**).

### 5. Predição linear sobre a janela recente
Regressão linear simples sobre as últimas N leituras de temperatura,
projetando 30-60min adiante. Frase resultante: *"Está em tendência de
aquecimento, atinge limite crítico em ~37min."* É a entrega de
previsão mais concreta que dá pra extrair de uma única janela de
telemetria.

### Persistência e RAG denso (médio prazo)
- Substituir o estado em memória por Postgres (dados estruturados) +
  Pinecone/Chroma/pgvector (chunks vetorizados).
- Trocar TF-IDF por embeddings densos (Cohere multilingual, OpenAI
  `text-embedding-3-small`, ou `transformers.js` no browser).
- Encaminhar os top-K chunks como contexto a um LLM (Claude, GPT,
  Llama) — mantendo as regras como fallback determinístico.

---

## Stack

- HTML semântico + CSS modular (sem framework de UI)
- Vanilla JS em módulos `window.GalileoX` (zero bundler, roda direto)
- Chart.js 4 (via CDN)
- Netlify Functions (Node 18, sem deps externas)
- Fontes: **Bricolage Grotesque** (display) + **JetBrains Mono**
  (dados)
