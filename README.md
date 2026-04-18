# xvc-agent2

An intelligent conversational task management assistant powered by AI agents, deployed on Cloudflare Workers.

[中文文档](./README.zh-CN.md)

## Features

- **Conversational Task Management** — Create, update, query, and delete tasks through natural language
- **AI Sub-Agent System** — Complex research tasks are decomposed and executed in parallel by isolated sub-agents
- **Hybrid RAG Search** — FTS5 keyword + Qdrant vector search, RRF fusion + MMR reranking for relevance and diversity
- **File Processing Pipeline** — Upload PDF/DOCX/TXT/MD/Images → auto parse → chunk → embed → vector store
- **Image OCR** — Upload images for OCR via GLM-4.6V, extracted text enters RAG pipeline
- **Long-term Memory** — User preferences and facts saved via `memory_save`, retrieved across conversations
- **Web Search Integration** — Real-time information retrieval via Serper.dev
- **Streaming Chat** — SSE-based real-time response streaming with flush optimization

## Architecture

```
Cloudflare Worker (Hono)
├── src/index.ts          — API routes + static file serving
├── src/agent/
│   ├── loop.ts           — AsyncGenerator-based agent loop (SSE/memory wrappers)
│   ├── sub-agent.ts      — Sub-agent spawn with heartbeat timeout
│   ├── tools.ts          — 11 tool definitions + convention-based dispatch
│   └── prompt.ts         — System prompt builder
├── src/llm/
│   ├── client.ts         — LLMClient (OpenAI-compatible, streaming)
│   └── embedding.ts      — EmbeddingClient
├── src/dao/
│   ├── d1.ts             — D1 operations (users, tasks, threads, messages, docs, chunks)
│   ├── qdrant.ts         — Qdrant HTTP API
│   └── outbox.ts         — Outbox for D1↔Qdrant consistency
├── src/services/
│   ├── search.ts         — Hybrid search: FTS5 + Qdrant → RRF fusion + MMR rerank
│   ├── upload.ts         — R2 → parse → clean → chunk → embed → Qdrant
│   ├── web.ts            — Serper search + URL fetch
│   └── ...
└── public/               — Vanilla HTML/CSS/JS frontend
```

### Agent Loop Design

The core `AgentLoop.execute()` returns `AsyncGenerator<AgentEvent>`, decoupling business logic from output:

- `run()` — SSE thin wrapper (for browser chat)
- `runSub()` — Memory collector wrapper (for sub-agents)
- Sub-agents are spawned via `spawn_agent` tool, executed in parallel with `Promise.allSettled`
- Heartbeat-based timeout: 10s with no event = abort

### Sub-Agent Flow

```
User asks complex question
  → Main agent calls spawn_agent({ tasks: ["task A", "task B"] })
    → Promise.allSettled([
        runSub(deps, "sub-0", userId, "task A"),
        runSub(deps, "sub-1", userId, "task B"),
      ])
    → Each sub-agent: isolated AgentLoop instance, max 15 rounds, no spawn_agent
  → Main agent synthesizes results into final response
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **LLM**: GLM API (OpenAI-compatible) with streaming
- **Vector DB**: Qdrant Cloud
- **SQL DB**: Cloudflare D1 (SQLite)
- **File Storage**: Cloudflare R2
- **Search API**: Serper.dev
- **Frontend**: Vanilla HTML + CSS + JavaScript (no build step)
- **Testing**: Vitest with `@cloudflare/vitest-pool-workers`

## Local Development

### Prerequisites

- Node.js ≥ 18
- A Cloudflare account (for D1, R2, and Workers)
- API keys (see below)

### Setup

```bash
# Clone
git clone https://github.com/lixianmin/xvc.agent2.git
cd xvc.agent2

# Install dependencies
npm install

# Create local dev config
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your API keys
```

### Environment Variables

Create `.dev.vars` in the project root:

```
GLM_API_KEY=your_glm_api_key
SILICONFLOW_API_KEY=your_siliconflow_api_key
SERPER_API_KEY=your_serper_api_key
QDRANT_URL=https://your-cluster.qdrant.io
QDRANT_API_KEY=your_qdrant_api_key
QDRANT_COLLECTION=xvc_agent_chunks
```

### Initialize Local Database

```bash
# Create D1 database locally
npx wrangler d1 execute xvc-agent2 --local --file=schema.sql
```

### Run

```bash
# Start dev server
npm run dev
# Open http://localhost:8787
```

### Test

```bash
# Run all tests (208 tests, 17 files)
npm test

# Watch mode
npm run test:watch
```

## Deployment

See [Deployment Guide](./docs/deployment.md) for step-by-step instructions.

## Implementation Notes

See [Implementation Notes (实现说明文档)](./docs/04.implementation-notes.md) for detailed architecture, sub-agent design, RAG pipeline, and challenges & solutions.

Quick version:

```bash
# 1. Create D1 database
npx wrangler d1 create xvc-agent2
# Update database_id in wrangler.toml

# 2. Initialize schema
npx wrangler d1 execute xvc-agent2 --remote --file=schema.sql

# 3. Create R2 bucket
npx wrangler r2 bucket create xvc-agent2-files

# 4. Create Qdrant collection (via Qdrant dashboard or API)

# 5. Set secrets
npx wrangler secret put GLM_API_KEY
npx wrangler secret put SILICONFLOW_API_KEY
npx wrangler secret put SERPER_API_KEY
npx wrangler secret put QDRANT_URL
npx wrangler secret put QDRANT_API_KEY
npx wrangler secret put QDRANT_COLLECTION

# 6. Deploy
npm run deploy
```

## Project Structure

```
├── src/
│   ├── index.ts              # Hono app entry point
│   ├── config.ts             # Configuration
│   ├── agent/                # AI agent core
│   ├── llm/                  # LLM & embedding clients
│   ├── dao/                  # Data access (D1, Qdrant, outbox)
│   ├── services/             # Business logic (search, upload, web, etc.)
│   └── middleware/            # Auth middleware
├── public/                   # Frontend (HTML/CSS/JS)
├── tests/
│   ├── unit/                 # 17 test files, 208 tests
│   └── integration/          # Curl-based integration tests
├── docs/                     # Specs, plans, memory
├── schema.sql                # D1 database schema
└── wrangler.toml             # Cloudflare Worker config
```

## License

Apache-2.0
