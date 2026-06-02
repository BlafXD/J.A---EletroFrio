# Galileo Watch

**Sistema de monitoramento, previsão de falhas e gestão contratual para
refrigeração comercial.**

Galileo Watch unifica os dados operacionais e contratuais da plataforma
Galileo (EletroFrio) em um console único: consome alarmes, cadastro de
unidades e telemetria de equipamentos em tempo real, cruza essas fontes,
e entrega indicadores, visualizações, consulta em linguagem natural
(RAG com IA generativa) e **notificação proativa via WhatsApp** quando
um alarme crítico é detectado.

**Produção**: https://radiant-sunburst-1294db.netlify.app/
**Página de inspeção de dados**: https://radiant-sunburst-1294db.netlify.app/debug.html

---

## Sumário

- [Contexto e problema](#contexto-e-problema)
- [Questão de pesquisa](#questão-de-pesquisa)
- [Objetivo geral](#objetivo-geral)
- [Objetivos específicos](#objetivos-específicos)
- [Justificativa](#justificativa)
- [Contexto de aplicação](#contexto-de-aplicação)
- [Arquitetura](#arquitetura)
- [Funcionalidades](#funcionalidades)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Execução local](#execução-local)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Deploy](#deploy)
- [Maturidade e roadmap](#maturidade-e-roadmap)
- [Stack](#stack)

---

## Contexto e problema

A operação de refrigeração comercial é silenciosa quando funciona e
catastrófica quando falha. Câmaras frigoríficas, expositores e ilhas de
congelados de um supermercado armazenam centenas de milhares de reais em
produto perecível, e a janela de tolerância entre "alarme disparado" e
"produto perdido" pode ser de poucas horas — às vezes minutos para itens
como sorvete e açougue.

A plataforma Galileo entrega dados ricos sobre essa operação: ocorrências
em tempo real, cadastro contratual das unidades e séries temporais por
dispositivo. O problema é que esses dados chegam em **três fontes
heterogêneas, sem correlação direta no momento da entrega**, dificultando
que um operador responda em segundos a perguntas como:

- Quais lojas têm alarmes graves agora e qual o impacto contratual delas?
- Existem dispositivos sinalizando comportamento anômalo antes do alarme
  oficial?
- Quais contratos estão a vencer **e** apresentam histórico de alarmes
  recentes?

E, criticamente: **o operador precisa ser avisado no momento em que o
problema acontece**, não apenas quando abre o painel.

## Questão de pesquisa

> Como antecipar falhas em equipamentos de refrigeração monitorados,
> notificar responsáveis em tempo real e priorizar intervenções
> considerando o contexto contratual de cada unidade, reduzindo perda de
> produto perecível e tempo de indisponibilidade?

## Objetivo geral

Desenvolver um sistema de monitoramento e suporte à decisão que unifique
os dados operacionais e contratuais da plataforma Galileo, permitindo a
antecipação de falhas, a identificação de anomalias em telemetria, a
notificação proativa de ocorrências críticas e a priorização de
intervenções com base no risco real para o negócio.

## Objetivos específicos

1. **Previsão de Falhas** — antecipar a ocorrência de falhas em
   equipamentos de refrigeração analisando o comportamento histórico
   recente de variáveis críticas (temperatura ambiente, setpoint,
   acionamentos de degelo) e identificando padrões precursores antes do
   disparo do alarme oficial.

2. **Identificação de Anomalias** — detectar desvios de comportamento em
   séries temporais de telemetria que fujam da operação normal de cada
   dispositivo (drift de setpoint, oscilação fora da banda estatística,
   períodos prolongados sem sinal de vida) e sinalizá-los visualmente ao
   operador.

3. **Priorização Inteligente de Intervenções** — combinar criticidade do
   alarme, janela de vencimento contratual e tempo desde o último sinal
   de vida em um score único de risco por loja, produzindo um ranking
   objetivo de onde a operação deve agir primeiro, em vez de tratar todos
   os alarmes com igual prioridade.

## Justificativa

A indisponibilidade de equipamentos de refrigeração em um supermercado
tem três custos diretos sobrepostos:

- **Perda de produto** — perecíveis (cárneos, laticínios, congelados,
  hortifrúti) descartados quando a cadeia do frio é rompida. Em uma câmara
  de médio porte, isso pode ultrapassar dezenas de milhares de reais em
  poucas horas.
- **Risco sanitário e regulatório** — produtos comercializados fora da
  curva de temperatura adequada expõem o consumidor e a rede a sanções da
  Vigilância Sanitária.
- **Custo operacional reativo** — atendimento técnico de emergência é
  significativamente mais caro do que manutenção planejada.

Reduzir o tempo entre o início de uma anomalia e a intervenção
qualificada — ou antecipar uma falha pela leitura de seus precursores —
gera retorno mensurável. É nesse vão que o Galileo Watch atua:
transformar dado bruto da plataforma em **ação priorizada e notificada**.

## Contexto de aplicação

O sistema foi desenhado para uso em **centros de operação (NOC) e equipes
de monitoramento remoto** que acompanham várias unidades em paralelo. Os
perfis de usuário:

- **Operadores de monitoramento** — precisam de um painel onde
  identifiquem em segundos onde há fogo, e de alertas que cheguem ao
  celular sem precisar estar com o painel aberto.
- **Coordenadores comerciais** — precisam cruzar a saúde operacional com a
  janela contratual para conversar com o cliente.
- **Equipes técnicas de campo** — precisam de priorização clara para
  rotear deslocamentos.

A interface foi pensada para uso primário em desktop de NOC (1080p+) e
suporta navegação em tablets e celulares. As notificações chegam por
WhatsApp.

---

## Arquitetura

```
                         ┌─────────────────────────────────────┐
                         │      Plataforma Galileo (EletroFrio) │
                         │   alarmes · unidades · telemetria    │
                         └──────────────────┬──────────────────┘
                                            │ (porta 5900, sem CORS)
                          ┌─────────────────┴──────────────────┐
                          │     Netlify Functions (servidor)    │
                          │  proxy.js  ·  llm.js  ·  webhook     │
                          │  alarmes-monitor.mjs (cron 5 min)    │
                          └───┬───────────────┬─────────────┬───┘
                              │               │             │
              ┌───────────────┘     ┌─────────┘       ┌─────┘
              ▼                     ▼                 ▼
      ┌───────────────┐    ┌──────────────┐   ┌──────────────┐
      │  Navegador     │    │  Gemini 2.5  │   │   Twilio →    │
      │  (dashboard +  │    │  Flash (LLM) │   │   WhatsApp    │
      │   RAG client)  │    └──────────────┘   │   (cliente)   │
      └───────────────┘                        └──────────────┘
```

O pipeline informacional segue: **ingestão → tratamento → enriquecimento
→ análise → (RAG | notificação)**.

- **Ingestão**: `proxy.js` contorna o CORS dos endpoints; o front e as
  functions consomem alarmes, unidades e telemetria.
- **Tratamento + enriquecimento**: normalização, dedupe, JOIN
  alarmes×unidades por `lojaId`.
- **RAG**: retrieval por TF-IDF + geração com Gemini 2.5 Flash, com
  fallback determinístico por regras.
- **Notificação proativa**: `alarmes-monitor.mjs` roda a cada 5 min,
  detecta alarmes críticos novos (dedupe via Netlify Blobs) e dispara
  WhatsApp via Twilio.

---

## Funcionalidades

### Ingestão e tratamento
- Coleta dos três endpoints (alarmes, unidades, telemetria)
- Normalização: trim de strings (resolve `"Afonso Pena "`,
  `" Cema Patrocínio"`), parse de datas (ISO e brasileiro), coerção
  numérica com vírgula decimal
- Mapeamento de criticidade (`C` → Crítica, `A` → Alta, `M` → Média,
  `B` → Baixa, `I` → Informativa)
- Descarte automático dos valores nulos do fim das séries de telemetria
- Dedupe por `alarmeId` e por `lojaId+contaId`
- Enriquecimento via JOIN alarmes × unidades

### Dashboard
- **5 indicadores (KPIs)**: alarmes ativos, alarmes graves (Alta+Crítica),
  unidades cadastradas, sinal de vida nas últimas 24h, contratos a vencer
  em 30 dias
- **Distribuição por criticidade** (donut)
- **Top-10 lojas por volume de alarmes** (barras)
- **Telemetria multi-série** (até 5 séries paralelas por dispositivo, com
  as cores fornecidas pela API)
- **Tabela enriquecida** de alarmes ativos com cruzamento contratual

### Consulta inteligente (RAG)
- **Retrieval**: chunking textual + TF-IDF cosseno
- **Generation**: Gemini 2.5 Flash via Netlify Function `/api/llm` (chave
  protegida em variável de ambiente)
- **Fallback determinístico**: se o LLM falhar, recai para regras
  pré-programadas — o sistema nunca fica sem resposta
- Badge indica a origem da resposta; cada resposta exibe os chunks-fonte

### Notificação proativa com diagnóstico por IA (WhatsApp)
- Monitor agendado (`alarmes-monitor.mjs`) executa a cada 5 minutos
- Detecta alarmes de criticidade Alta/Crítica ainda não notificados
- Para cada alarme, usa o `dispositivoId` para **buscar a telemetria do
  equipamento**, analisa as séries (temperatura × setpoint, tendência,
  oscilação) e pede ao **Gemini um diagnóstico técnico** do problema
- Envia ao responsável: cabeçalho do alarme + contexto contratual +
  **diagnóstico da IA** + convite para conversar
- Dedupe persistente via Netlify Blobs; bootstrap evita disparo em massa

### Chatbot contextual (WhatsApp)
- Quando o responsável **responde** a uma notificação, o webhook
  (`whatsapp-webhook.mjs`) recupera o **contexto do alarme** (Blobs),
  rebusca a **telemetria atual** do dispositivo e pede ao Gemini uma
  resposta fundamentada — permitindo perguntas como "melhorou?",
  "o que faço agora?", "qual a temperatura atual?"
- Degrada com elegância: se o Gemini estiver indisponível, responde com
  o diagnóstico/dados já conhecidos

---

## Estrutura do projeto

```
galileo-watch/
├── index.html                  dashboard
├── debug.html                  inspeção da estrutura crua dos endpoints
├── css/
│   ├── reset.css
│   ├── tokens.css              design tokens (cores, tipografia)
│   ├── layout.css              topbar, grid, breakpoints
│   └── components.css          kpis, painéis, tabela, tags, RAG
├── js/
│   ├── config.js               URLs e parâmetros
│   ├── api.js                  cliente dos 3 endpoints
│   ├── processor.js            normalização, dedupe, enriquecimento
│   ├── analytics.js            agregações de KPIs e gráficos
│   ├── charts.js               wrappers Chart.js
│   ├── rag.js                  retrieval + chamada ao LLM + fallback
│   ├── ui.js                   renderização do DOM
│   └── main.js                 orquestrador
├── netlify/
│   ├── lib/
│   │   └── galileo.mjs         módulo compartilhado: coleta, processamento,
│   │                           análise de telemetria, Gemini e Twilio
│   └── functions/
│       ├── proxy.js            proxy CORS para os endpoints Galileo
│       ├── llm.js              geração RAG do dashboard (Gemini 2.5 Flash)
│       ├── alarmes-monitor.mjs monitor agendado → diagnóstico IA + WhatsApp
│       ├── whatsapp-webhook.mjs chatbot contextual (responde o dono da loja)
│       └── test-whatsapp.mjs   disparo de teste/demonstração sob demanda
├── package.json                dependência @netlify/blobs
├── netlify.toml                build, functions, redirects
├── .gitignore                  ignora node_modules, .netlify, .env
└── README.md
```

---

## Execução local

```bash
# dependências (uma vez)
npm install
npm install -g netlify-cli

# rodar
netlify dev
```

Abre em `http://localhost:8888`. O `netlify dev` carrega as functions,
os redirects e as variáveis de ambiente locais.

Para testar o monitor de alarmes manualmente (sem esperar o cron):

```bash
netlify functions:invoke alarmes-monitor
```

---

## Variáveis de ambiente

Configuradas no Netlify (*Site settings → Environment variables*) e, para
desenvolvimento local, em um arquivo `.env` na raiz (ignorado pelo Git).

| Variável | Para que serve |
|---|---|
| `GEMINI_API_KEY` | Geração de respostas do RAG (Gemini 2.5 Flash) |
| `TWILIO_ACCOUNT_SID` | Conta Twilio (envio de WhatsApp) |
| `TWILIO_AUTH_TOKEN` | Token Twilio |
| `TWILIO_WHATSAPP_FROM` | Número de origem, ex. `whatsapp:+14155238886` |
| `ALERT_WHATSAPP_TO` | Número de destino (responsável), ex. `whatsapp:+5541...` |

Exemplo de `.env` local:

```
GEMINI_API_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
ALERT_WHATSAPP_TO=whatsapp:+5541999999999
```

> **Nunca** comite o `.env`. O `.gitignore` já o protege.

---

## Deploy

O projeto está vinculado ao GitHub via deploy contínuo do Netlify: todo
push na branch principal dispara um deploy automático. O `netlify.toml`
define `publish = "."`, o diretório de functions e o bundler; o
`package.json` aciona o `npm install` no build (necessário para o
`@netlify/blobs`).

---

## Maturidade e roadmap

O sistema é um **MVP funcional e hospedado**, com ingestão real, IA
generativa e notificação proativa operando em produção. Para evoluir a um
patamar de produção corporativa plena, os próximos passos técnicos são:

**Persistência e histórico**
- Hoje o estado analítico vive em memória (recalculado a cada carga). Um
  banco relacional (PostgreSQL) permitiria histórico, tendências de longo
  prazo e consultas analíticas.
- Vector store dedicado (pgvector/Pinecone) com embeddings densos elevaria
  a qualidade do retrieval acima do TF-IDF atual.

**Inteligência preditiva**
- Score de risco por loja (criticidade × contrato × sinal de vida)
- Detecção de outlier em telemetria (média móvel ± desvio-padrão)
- Drift de setpoint (alerta antes do alarme oficial)
- Predição linear de tendência de temperatura

**Robustez e operação**
- Autenticação e perfis de acesso
- Validação de assinatura nos webhooks (segurança)
- Testes automatizados e observabilidade (logs estruturados, métricas)
- Expiração (TTL) dos registros de dedupe no Blobs

**Integração**
- Abertura automática de chamado (endpoint `abrir-chamado`) a partir de
  alarmes críticos
- Canais adicionais de notificação (e-mail, Telegram, push)

---

## Stack

- HTML semântico + CSS modular (sem framework de UI)
- JavaScript em módulos (front: `window.GalileoX`; functions: Node 18)
- Chart.js 4 (visualizações)
- Netlify Functions + Scheduled Functions + Netlify Blobs
- Google Gemini 2.5 Flash (geração RAG)
- Twilio (WhatsApp)
- Fontes: Bricolage Grotesque (display) + JetBrains Mono (dados)
