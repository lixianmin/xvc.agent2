# AI Task Management Assistant - Architecture Design

## Overview

A conversational AI task management assistant deployed on Cloudflare Worker. Users interact through a web chat interface to manage tasks, upload files, search the web, and query documents via RAG. All via natural language — no traditional forms.

**Tech Stack**: TypeScript, Hono, Cloudflare Worker/D1/R2, Qdrant, GLM API, Serper.dev

**Key Decisions**:
- CF Worker full-stack (Worker API + Pages frontend)
- Pure HTML + Vanilla JS frontend (no build step)
- GLM as primary LLM + embedding provider
- Qdrant hybrid mode (local dev + cloud production)
- Outbox table for D1↔Qdrant dual-write consistency
- No CF Queue — synchronous dual-write with outbox as fallback

---

## 1. User Management (Code-Driven, Not AI)

Traditional form-based registration, not AI-driven:

```
Frontend load → Check localStorage for userId
  → Exists: GET /api/user verify → show chat
  → Missing: show registration form (name + email) → POST /api/user → store userId
```

- Identity: `X-User-Id` header on every request
- Middleware validates user exists
- No password, no session — trust userId (sufficient for demo)
- User can set/modify AI nickname via settings

---

## 2. Agent Loop

### Flow

```
User message → [LLM call] → parse response
                              ↓
                 has tool_calls? → dispatch tools → inject results → [LLM call]
                 no tool_calls?  → stream text response to user
```

### Implementation

- `AgentLoop` class, method `run(userId, conversationId, userMessage)` returns `ReadableStream` (SSE)
- SSE events: `{ type: "text" | "tool_call" | "tool_result", ... }`
- Max 15 tool-calling rounds per request
- System prompt dynamically built: user info + date + tool descriptions + relevant chunks from RAG

### Tools

| Tool | Function | Data Layer |
|------|----------|------------|
| `task_create` | Create task (title, description, priority) | D1 |
| `task_list` | List/filter tasks | D1 |
| `task_update` | Update task content/status | D1 |
| `task_delete` | Delete task | D1 |
| `web_search` | Serper web search | Serper API |
| `web_fetch` | Fetch and extract URL content | HTTP |
| `file_upload` | Upload file to workspace (triggers async parse→chunk→embed) | R2 + D1 + Qdrant |
| `file_list` | List workspace files | D1 |
| `file_delete` | Delete file and its chunks | R2 + D1 + Qdrant |
| `chunks_search` | Unified search (keyword + vector hybrid, RRF fusion) | D1 FTS5 + Qdrant |

### Tool Dispatch

Convention-based: tool name `web_search` → handler function `do_web_search`. No interface, no registry — just a mapping object.

### Deep Research

Not a separate tool. The agent loop naturally supports multi-round tool calls:
1. LLM decomposes research question into sub-queries
2. Calls `web_search` + `web_fetch` multiple times
3. Synthesizes structured report
4. 15-round limit provides enough space for research tasks

System prompt instructs the LLM on this capability.

---

## 3. Data Model (D1)

### Tables

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ai_nickname TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_results TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  position INTEGER NOT NULL,
  token_count INTEGER,
  hash TEXT NOT NULL,
  UNIQUE(doc_id, seq)
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content = 'chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TABLE outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('embed_chunk','delete_vector')),
  chunk_id INTEGER,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tasks_user ON tasks(user_id);
CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_documents_user ON documents(user_id);
CREATE INDEX idx_chunks_doc ON chunks(doc_id);
CREATE INDEX idx_outbox_status ON outbox_events(status, created_at);
```

---

## 4. Dual-Database Consistency (Outbox as Fallback)

D1 (relational + FTS) and Qdrant (vectors) are independent databases. No cross-DB transactions.

### Strategy: Sync Dual-Write + Outbox Safety Net

**Primary path (synchronous)**:
```
1. [D1 transaction] Write chunks metadata + chunks_fts + outbox_events(pending)
2. [Immediate] Call GLM embedding API → get vectors
3. [Immediate] Write vectors to Qdrant
4. [D1] Mark outbox_events as completed
```

**Fallback path (Cron Trigger)**:
```
1. Cron scans outbox_events WHERE status='pending' AND updated_at < now - 30s
2. Retry: embed → write Qdrant → mark completed
3. After 3 failed attempts → mark 'failed', stop retrying
```

Outbox is a safety net, not the driver. Primary path attempts synchronous dual-write. Outbox only catches failures for eventual consistency.

---

## 5. Storage Mapping

| Data | Storage | Index |
|------|---------|-------|
| Users | D1 | email (unique) |
| Tasks | D1 | user_id |
| Conversations + Messages | D1 | conversation_id |
| Document metadata | D1 | user_id |
| Chunk metadata + content | D1 | doc_id, hash |
| Full-text index | D1 FTS5 | content (porter + unicode61) |
| Vectors | Qdrant | cosine similarity (dim=1024) |
| Raw files | R2 | user/{userId}/{filename} |
| Outbox events | D1 | status + created_at |

---

## 6. File Processing Pipeline

```
File upload → R2 (raw file)
    ↓
Parse (PDF/Word/TXT/MD → plain text)
    ↓
Chunk (heading-aware, ~500 tokens, 15% overlap, reference qmd scoring)
    ↓
[D1 transaction] Write chunks + chunks_fts + outbox(pending)
    ↓
[Sync] GLM embedding API → vectors
    ↓
[Sync] Qdrant upsert vectors
    ↓
[Sync] Mark outbox completed
    ↓
[Fallback] Cron retries if any step failed
```

---

## 7. Unified Search (chunks_search)

Single tool searches all chunks — no distinction between "file search" and "memory search".

### Modes

| Mode | Backend | Use Case |
|------|---------|----------|
| `keyword` | D1 FTS5 BM25 | Exact term matching |
| `vector` | Qdrant cosine | Semantic similarity |
| `hybrid` | Both + RRF fusion | Best of both (default) |

### RRF Fusion (reference: qmd)

```
1. Run FTS5 search → ranked list A
2. Run Qdrant search → ranked list B
3. RRF: score(doc) = Σ weight / (k + rank + 1)  [k=60]
4. First 2 lists get 2x weight (original query results)
5. Top-rank bonus: rank #1 gets +0.05, ranks #2-3 get +0.02
6. Return top-N results sorted by RRF score
```

---

## 8. LLM Layer

### LLMClient

- Class (not interface — single implementation per AGENTS.md)
- Constructor: `{ apiKey, baseUrl, model }`
- Method: `chat(messages, tools?, stream?)` → `AsyncGenerator<ChatEvent>`
- OpenAI-compatible API format (GLM uses this)
- SSE stream parsing with tool_calls extraction

### EmbeddingClient

- Class, constructor: `{ apiKey, baseUrl, model }`
- Method: `embed(texts: string[])` → `number[][]`
- GLM embedding model, dimension 1024
- Batch processing

### System Prompt Construction

Dynamic prompt built per request:
1. Base instructions (role, capabilities, guidelines)
2. User info (name, AI nickname)
3. Current date
4. Available tools (JSON schema)
5. Relevant chunks from RAG (if search was triggered)

### Context Management

- Send: system prompt + last N messages (token budget: ~8000 tokens for context)
- Tool calls/results stored as messages in conversation chain
- No summary compression in MVP

---

## 9. API Routes (Hono)

```
# User
POST   /api/user                    # Create user
GET    /api/user/:id                # Get user info
PUT    /api/user/:id                # Update user (nickname)

# Conversations
GET    /api/conversations           # List conversations
POST   /api/conversations           # Create conversation
DELETE /api/conversations/:id       # Delete conversation

# Chat (core)
POST   /api/chat/:convId            # Send message, SSE stream response

# Tasks
GET    /api/tasks                   # List tasks
POST   /api/tasks                   # Create task
PUT    /api/tasks/:id               # Update task
DELETE /api/tasks/:id               # Delete task

# Files
POST   /api/files/upload            # Upload file
GET    /api/files                   # List files
DELETE /api/files/:id               # Delete file

# Admin (testing)
POST   /api/admin/process-outbox    # Manually trigger outbox processing
GET    /api/admin/outbox-status     # Check outbox status

# Static
GET    /*                           # Frontend HTML/JS/CSS
```

All endpoints stateless, curl-friendly for testing.

---

## 10. Frontend (Pure HTML + Vanilla JS)

Single-page app, three view states managed by JS DOM manipulation:

1. **Registration view**: Form (name + email), shown when no userId in localStorage
2. **Chat view**: Message list + input box + SSE stream display + tool call visualization
3. **Workspace view**: File list + upload + delete, switchable from chat view

No router, no build step. Static files served by Worker from `public/`.

### SSE Handling

```javascript
const eventSource = new EventSource(`/api/chat/${convId}`, {
  headers: { 'X-User-Id': userId }
});
// or fetch with ReadableStream for POST
```

POST-based SSE (since we send message body):
```javascript
const response = await fetch(`/api/chat/${convId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
  body: JSON.stringify({ content: message })
});
const reader = response.body.getReader();
// parse SSE events from stream
```

---

## 11. Project Structure

```
xvc.agent2/
├── src/
│   ├── index.ts                 # Hono app entry, routes, bindings
│   ├── agent/
│   │   ├── loop.ts              # AgentLoop class
│   │   ├── tools.ts             # Tool definitions + dispatch
│   │   └── prompt.ts            # System prompt builder
│   ├── llm/
│   │   ├── client.ts            # LLMClient class
│   │   └── embedding.ts         # EmbeddingClient class
│   ├── dao/
│   │   ├── d1.ts                # D1 operations (users, tasks, conversations, messages, documents, chunks)
│   │   ├── qdrant.ts            # Qdrant operations (upsert, search vectors)
│   │   └── outbox.ts            # Outbox event management
│   ├── services/
│   │   ├── parser.ts            # File parsing (PDF, Word, TXT, MD → text)
│   │   ├── chunker.ts           # Heading-aware chunking (reference: qmd)
│   │   ├── search.ts            # chunks_search: FTS5 + Qdrant hybrid + RRF
│   │   └── web.ts               # Serper search + URL fetch
│   └── middleware/
│       └── auth.ts              # X-User-Id validation middleware
├── public/
│   ├── index.html               # Main page (registration + chat + workspace)
│   ├── style.css                # Styles
│   └── app.js                   # Frontend logic
├── tests/
│   ├── unit/                    # Unit tests (vitest + miniflare)
│   └── integration/             # Integration test scripts (curl-friendly)
├── docs/
│   ├── 00.原始需求.md
│   ├── 01.memory.md
│   ├── 02.todo.md
│   └── superpowers/specs/
├── wrangler.toml                # CF Worker config (D1, R2 bindings, Cron)
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── Agents.md
```

---

## 12. Testing Strategy

### Unit Tests (vitest + miniflare)

- Each module tested in isolation
- D1: use miniflare's D1 simulator
- Qdrant: mock HTTP calls
- LLM: mock API responses
- Coverage target: core modules >= 80%

### Integration Tests (tests/integration/)

- Standalone scripts callable from command line
- Test full flows: user registration → chat → task CRUD → file upload → search
- Each test script uses `fetch` to hit the Worker API
- Can run against `wrangler dev` locally or deployed instance

### API Design for Testability

- All endpoints accept JSON, return JSON (except SSE chat)
- No complex auth — just `X-User-Id` header
- Admin endpoints for manual outbox processing
- curl-friendly: every endpoint testable with a single curl command

---

## 13. Deployment

### Wrangler Configuration

```toml
name = "xvc-agent2"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "xvc-agent2"
database_id = "TBD"

[[r2_buckets]]
binding = "FILES"
bucket_name = "xvc-agent2-files"

[triggers]
crons = ["*/5 * * * *"]  # Outbox retry every 5 minutes
```

### Local Development

```bash
wrangler dev    # Starts local Worker with D1/R2 simulation
# Qdrant: docker run -p 6333:6333 qdrant/qdrant
```

### Production

```bash
wrangler deploy  # Deploy to CF Worker
wrangler d1 execute xvc-agent2 --file=schema.sql  # Run migrations
```

---

## 14. Reference Projects

- **generic-agent** (`/Users/xmli/me/code/others/generic-agent`): Agent loop pattern, tool dispatch, multi-round orchestration
- **qmd** (`/Users/xmli/me/code/others/qmd`): Hybrid search, RRF fusion, heading-aware chunking, FTS5 integration
