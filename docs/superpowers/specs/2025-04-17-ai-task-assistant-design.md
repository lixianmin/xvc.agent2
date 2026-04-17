# AI Task Management Assistant - Architecture Design

## Overview

A conversational AI task management assistant deployed on Cloudflare Worker. Users interact through a web chat interface to manage tasks, upload files, search the web, and query documents via RAG. Task management and search are via natural language; user registration uses a simple form.

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

**Design deviation from original requirement**: Original §2.1 says "当用户未提供邮箱和姓名时，AI 主动询问并存储". We use traditional form-based registration instead. Rationale: simpler UX, avoids AI hallucination during identity collection, more reliable user identification. See memory.md for record.

```
Frontend load → Check localStorage for userId
  → Exists: GET /api/user verify → show chat
  → Missing: show registration form (name + email) → POST /api/user/create → store userId
```

- Identity: `X-User-Id` header on every request
- Middleware validates user exists
- No password, no session — trust userId (sufficient for demo)
- User can set/modify AI nickname via settings or natural language ("叫我小明")

---

## 2. Agent Loop

### Flow

```
User message → [LLM call] → parse response
                              ↓
                 has tool_calls? → dispatch ALL tools → inject results → [LLM call]
                 no tool_calls?  → stream text response to user
```

**Key**: A single LLM response may produce **multiple tool_calls** (e.g., 5-8 calls). All are dispatched and executed, then all results are injected back before the next LLM call. This is not one-tool-per-turn — it's batch execution per LLM response.

Reference: generic-agent `agent_runner_loop` (agent_loop.py:118-242) — iterates `tool_calls` list from response, dispatches each, collects outcomes.

### Implementation

- `AgentLoop` class, method `run(userId, threadId, userMessage)` returns `ReadableStream` (SSE)
- Each LLM response may contain 0-N tool_calls. When N > 0, all N tools execute, results stream back, then next LLM call happens
- "Round" = one LLM call + its tool executions. Max 30 rounds
- SSE events stream tool_call/tool_result as they happen (not batched)
- System prompt dynamically built per section below

### Tools

| Tool | Function | Data Layer |
|------|----------|------------|
| `task_create` | Create task (title, description, priority) | D1 |
| `task_list` | List/filter tasks | D1 |
| `task_update` | Update task content/status | D1 |
| `task_delete` | Delete task | D1 |
| `web_search` | Serper web search | Serper API |
| `web_fetch` | Fetch and extract URL content | HTTP |
| `file_list` | List workspace files | D1 |
| `file_delete` | Delete file and its chunks | R2 + D1 + Qdrant |
| `chunks_search` | Unified search (keyword + vector hybrid, RRF fusion) | D1 FTS5 + Qdrant |
| `memory_save` | Save key info to long-term memory (see memory spec) | D1 + Qdrant |

### Tool Dispatch

Convention-based: tool name `web_search` → handler function `do_web_search`. No interface, no registry — just a mapping object.

### SSE Events

SSE stream emits three categories of events:

**1. LLM content events** — persisted to `messages` table, included in future LLM context:
- `{ type: "text", content: "..." }` — assistant text response
- `{ type: "tool_call", name: "...", args: {...}, call_id: "..." }` — tool invocation
- `{ type: "tool_result", name: "...", call_id: "...", result: "..." }` — tool output

**2. Status events** — UI-only progress indicators, NOT persisted, NOT sent to LLM:
- `{ type: "status", content: "正在检索相关文档..." }` — RAG pre-retrieval started
- `{ type: "status", content: "正在思考..." }` — LLM call started
- `{ type: "status", content: "正在搜索网页..." }` — tool dispatch started
- `{ type: "status", content: "正在处理文件..." }` — file processing
- `{ type: "status", content: "已完成搜索，正在整合结果..." }` — tool completed, next step

Status events are shown as lightweight chat bubbles in the UI to reassure users the agent is active. They are ephemeral: never saved to DB, never injected into LLM context.

### Console Logging

All agent loop state transitions are logged via `console.log` for debugging:
- `[agent] user message received: convId=..., content=...`
- `[agent] LLM call started: round X`
- `[agent] tool_call: name=..., args=...`
- `[agent] tool_result: name=..., duration=...ms`
- `[agent] LLM call completed: round X, tokens=...`
- `[agent] loop ended: rounds=..., reason=completed|limit_reached|error`
- `[outbox] processing event: id=..., type=..., status=...`
- `[search] mode=hybrid, query=..., fts_results=..., vec_results=..., rrf_top=...`

### Message Persistence

During the agent loop:
1. User message saved as `role='user'` row before loop starts
2. Each LLM response saved as `role='assistant'` row. If response contains tool_calls, `tool_calls` column stores the JSON array
3. Each tool result saved as a separate `role='tool'` row, with `tool_call_id` linking back to the assistant's tool_call
4. All messages in a single thread share the same `thread_id`
5. Threads table `updated_at` refreshed on each new message
6. **Status events are NOT persisted** — they are UI-only, ephemeral

### Deep Research

Not a separate tool. The agent loop supports deep research through multi-round tool calls orchestrated by a research-specific system prompt extension:

1. LLM receives complex research question
2. Research prompt instructs: decompose into sub-questions, search each, synthesize
3. LLM outputs a research plan as text (e.g., "Sub-question 1: ..., Sub-question 2: ...")
4. For each sub-question: calls `web_search` → `web_fetch` → extracts findings
5. After all sub-questions researched: synthesizes structured report with citations
6. 30-round limit provides space for 3-5 sub-questions with search+fetch each

### Sub-Agent (Implemented — See spawn_agent spec)

**实现方案**: `AgentLoop` 重构为 AsyncGenerator，`execute()` 返回 `AsyncGenerator<AgentEvent>`。SSE 和子代理都是 `execute()` 的薄包装。详见 `docs/superpowers/specs/2025-04-17-spawn-agent-design.md`。

- Sub-agent is a **tool** (`spawn_agent`) that the main LLM can call
- Sub-agent runs with **isolated context**: its own system prompt, no access to parent thread
- Input: task description + optional context (explicitly passed by main agent)
- Output: free-text result returned to main agent as tool_result
- Main agent decides how to use the result
- Up to 3 sub-agents in parallel via `Promise.allSettled`
- Sub-agent uses same `AgentLoop.execute()` with different options (maxRounds=15, no persistence, no spawn_agent)

**Deep research**: Planned to use spawn_agent instead of prompt-guided workaround. Currently still uses prompt-guided multi-round tool calls. Will switch after spawn_agent implementation (Phase 2).

### Error Handling

- **Malformed tool_calls**: Agent loop catches parse errors, injects error as tool_result back to LLM for self-correction
- **Tool execution failure**: Wrapped in try/catch, error message returned as tool_result so LLM can retry or explain to user
- **Round limit reached (30)**: Agent loop terminates with a message: "I've reached my processing limit. Let me summarize what I've found so far..."
- **LLM API failure**: Returns error to frontend, displayed to user with retry option
- **Qdrant unreachable during chunks_search**: Falls back to keyword-only (FTS5) mode, logs warning

---

## 3. Data Model (D1)

### Tables

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ai_nickname TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
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
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX idx_tasks_user ON tasks(user_id);
CREATE INDEX idx_threads_user ON threads(user_id);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX idx_documents_user ON documents(user_id);
CREATE INDEX idx_outbox_status ON outbox_events(status, created_at);
```

**messages 表设计说明**:
- `role='user'`: content 为用户消息文本，tool_calls/tool_call_id 为 NULL
- `role='assistant'`: content 为文本响应；若有工具调用，tool_calls 存 OpenAI 格式的 tool_calls JSON 数组
- `role='tool'`: content 为工具执行结果，tool_call_id 关联到对应 assistant 消息中的 tool_call
- 每个 tool_call 生成一条独立的 `role='tool'` 行，通过 `tool_call_id` 关联

**索引设计说明**:
- `idx_chunks_doc` 省略: `UNIQUE(doc_id, seq)` 约束自动创建索引
- `idx_messages_thread_created` 复合索引: 同时覆盖 WHERE thread_id=? 和 ORDER BY created_at

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
| Threads + Messages | D1 | thread_id |
| Document metadata | D1 | user_id |
| Chunk metadata + content | D1 | doc_id or user_id (for chat memories) |
| Chat memories | D1 (chunks, source='chat') + Qdrant | user_id, expires_at |
| Full-text index | D1 FTS5 | content (porter + unicode61) |
| Vectors | Qdrant | cosine similarity (dim=1024) |
| Raw files | R2 | user/{userId}/{timestamp}_{filename} |
| Outbox events | D1 | status + created_at |

### Qdrant Collection Schema

```
Collection: configurable via QDRANT_COLLECTION env var (default: xvc_agent_chunks)
Vectors: dim=1024, distance=cosine
Payload per point (document chunks):
  - chunk_id: integer (matches D1 chunks.id)
  - doc_id: integer (matches D1 documents.id)
  - user_id: integer
  - seq: integer (chunk sequence number)
Payload per point (chat memories, added by memory_save tool):
  - chunk_id: integer (matches D1 chunks.id)
  - user_id: integer
  - source: string ('chat')
  - content: string (full memory text)
  - category: string ('preference' | 'fact' | 'plan')
  - expires_at: string | null (ISO datetime, null = never expire)
```

Initialization: create collection on first run if not exists (check via Qdrant API).

---

## 6. File Processing Pipeline

```
POST /api/files/upload (HTTP API, not agent tool)
    ↓
File upload → R2 (raw file)
    ↓
Parse (PDF/Word/TXT/MD → plain text)
    ↓
Clean (normalize whitespace, strip control chars, remove boilerplate)
    ↓
Chunk (heading-aware chunking algorithm below)
    ↓
[D1 transaction] Write chunks + chunks_fts(tokenized) + outbox(pending)
    ↓
[Sync] GLM embedding API → vectors
    ↓
[Sync] Qdrant upsert vectors
    ↓
[Sync] Mark outbox completed
    ↓
[Fallback] Cron retries if any step failed
```

### Text Cleaning (before chunking and embedding)

Applied to parsed text before chunking and embedding:
1. Normalize whitespace: collapse multiple spaces/newlines, trim
2. Strip control characters (except newline/tab)
3. Remove HTML tags (for PDF/Word extraction artifacts)
4. Normalize Unicode: NFC normalization

Reference: qmd does minimal cleaning — relies on clean input. We add basic sanitization since user-uploaded files may have extraction artifacts.

### CJK Tokenization for FTS5 (before FTS insertion, not embedding)

`unicode61` tokenizer cannot split Chinese text into words. Application-layer CJK segmentation is required:

**Implementation** (reference: qmd `src/cjk.ts`):
1. Use `Intl.Segmenter` (built-in, zero dependencies) with locale `zh` for Chinese text
2. Split text into script runs (Han, Kana, Hangul, other) via Unicode range detection
3. For each CJK run: `segmenter.segment(text)` → filter `isWordLike` → join with spaces
4. Non-CJK text passes through unchanged
5. Applied to chunk content **before FTS5 insertion** and **before FTS5 query**
6. **NOT applied before embedding** — embedding models handle CJK natively

```typescript
// Pseudocode
function tokenizeCJK(text: string): string {
  if (!containsCJK(text)) return text;
  const chunks = splitByScript(text);
  return chunks.map(chunk => {
    if (chunk.script === 'han') return segmentByIntl(chunk.text, zhSegmenter);
    return chunk.text;
  }).join(' ');
}
```

**Applied at two points**:
- Index time: `syncChunkToFTS()` calls `tokenizeCJK(content)` before INSERT into `chunks_fts`
- Query time: `searchFTS()` calls `tokenizeCJK(query)` before building FTS5 query

### Chunking Algorithm (reference: qmd src/store.ts:72-308)

**Parameters**: target ~500 tokens per chunk, 15% overlap (~75 tokens), search window ~100 tokens

**Break point scoring**:
| Pattern | Score | Type |
|---------|-------|------|
| `# Heading` | 100 | h1 |
| `## Heading` | 90 | h2 |
| `### Heading` | 80 | h3 |
| `` ``` `` (code fence) | 70 | codeblock |
| `---` / `***` | 60 | horizontal rule |
| Blank line | 20 | paragraph |
| Line break | 1 | newline |

**Algorithm**:
1. Split text into lines, identify all break points with scores
2. Walk through text accumulating tokens
3. When approaching 500-token target, search a 100-token window for best break point
4. Score adjustment: `finalScore = baseScore * (1 - (distance/window)^2 * 0.7)` — squared distance decay prefers nearby headings over distant ones
5. Code fence protection: no breaks inside code blocks
6. Each chunk stores: content, seq, token_count

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
1. Tokenize query with tokenizeCJK()
2. Run FTS5 search with tokenized query → ranked list A
3. Run Qdrant search with original query embedding → ranked list B
4. (Optional future) LLM query expansion generates sub-queries → additional lists C, D...
5. RRF: score(chunk) = Σ weight / (k + rank + 1)  [k=60]
6. Lists A and B (from original query) get 2x weight vs expansion lists
7. Top-rank bonus: rank #1 gets +0.05, ranks #2-3 get +0.02
8. Return top-N results sorted by RRF score
```

For MVP: skip LLM query expansion (steps 3, 5). Only fuse FTS5 + Qdrant results with equal weights.

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

Prompt assembled in order (tools first for prefix caching stability):

1. **Available tools** (JSON schema) — fixed content, stable for prefix caching
2. **Base instructions** (role, capabilities, guidelines) — fixed content
3. **User info** (name, AI nickname) — changes rarely
4. **RAG context** (auto-retrieved: embed user message → chunks_search hybrid → top relevant chunks injected into prompt) — variable per request
5. **Current datetime** (精确到秒，如 `2025-04-17 14:30:00 CST`) — changes every request

**RAG auto-pre-retrieval**: Before each agent loop starts, the user's message is automatically used to query chunks_search (hybrid mode, top 5). Results are formatted as context and injected into position 4. This happens before any LLM call, so the LLM always has relevant document context from the start. The LLM can also explicitly call `chunks_search` tool for follow-up queries within the loop.

### Context Management

Reference: generic-agent's `trim_messages_history` (llmcore.py:74-86) and `compress_history_tags` (llmcore.py:23-54).

**Budget**: ~8000 tokens for message history (system prompt excluded from this budget)

**Message selection**:
1. Load messages from DB ordered by `created_at DESC`
2. Accumulate newest-first until token budget reached
3. **Always keep complete tool chains**: if an `assistant` row with `tool_calls` is included, all associated `tool` rows must be included. Never split a tool_call→tool_result chain
4. If trimming would split a chain, include the entire chain or exclude it entirely
5. Safety floor: always keep at least the last user message + last assistant response

**Token estimation**: ~4 chars per token (Chinese+English mixed)

**Context reconstruction**: Each DB row maps to one LLM message:
- `role='user'` → user message
- `role='assistant'` with `tool_calls` JSON → assistant message with tool_calls array
- `role='tool'` with `tool_call_id` → tool message linked to the corresponding tool_call

**Trimming** (when total exceeds budget):
1. Drop oldest messages first (from front of history)
2. If dropping creates orphaned tool results (tool_call removed but tool_result remains), convert orphaned tool_result to plain text and append to nearest user message
3. Never trim below the safety floor

**Tool schema caching**: Tool definitions are in the fixed system prompt prefix (see System Prompt Construction), so they benefit from prefix caching automatically. No need for generic-agent's `last_tools` rotation pattern.

**No summary compression in MVP** — future: add running summary like generic-agent's `history_info` + `<summary>` protocol to compress older turns.

---

## 9. API Routes (Hono) — RPC Style

All routes use GET for reads, POST for writes. No PUT, no DELETE.

```
# User
POST   /api/user/create              # Body: { email, name } → { id, email, name }
GET    /api/user/:id                  # → { id, email, name, ai_nickname }
POST   /api/user/update              # Body: { id, name?, ai_nickname? } → updated user

# Threads
GET    /api/threads/list              # Query: ?userId= → [{ id, title, created_at }]
POST   /api/threads/create            # Body: { userId, title? } → { id, title }
GET    /api/threads/:id/messages      # Query: ?limit=&before= → [{ id, role, content, ... }]
POST   /api/threads/delete            # Body: { id } → { ok: true }

# Chat (core)
POST   /api/chat                      # Body: { threadId, content } Headers: X-User-Id
                                    # → SSE stream of ChatEvent

# Tasks
GET    /api/tasks/list                # Query: ?userId=&status= → [{ id, title, ... }]
POST   /api/tasks/create              # Body: { userId, title, description?, priority? }
POST   /api/tasks/update              # Body: { id, title?, description?, status?, priority? }
POST   /api/tasks/delete              # Body: { id } → { ok: true }

# Files
POST   /api/files/upload              # FormData: { file, userId } → { id, filename, ... }
GET    /api/files/list                # Query: ?userId= → [{ id, filename, size, ... }]
POST   /api/files/delete              # Body: { id } → { ok: true } (also removes chunks + Qdrant vectors)

# Admin (testing)
POST   /api/admin/process-outbox      # → { processed: number }
GET    /api/admin/outbox-status       # → { pending, processing, failed, completed }

# Static
GET    /*                             # Frontend HTML/JS/CSS
```

### ChatEvent SSE Format

```
data: {"type":"text","content":"正在搜索..."}
data: {"type":"tool_call","name":"web_search","args":{"q":"query"},"call_id":"call_123"}
data: {"type":"tool_result","name":"web_search","call_id":"call_123","result":"..."}
data: {"type":"text","content":"根据搜索结果..."}
data: [DONE]
```

All endpoints stateless, curl-friendly for testing.

---

## 10. Frontend (Pure HTML + Vanilla JS)

Single-page app, three view states managed by JS DOM manipulation:

1. **Registration view**: Form (name + email), shown when no userId in localStorage
2. **Chat view**: Message list + input box + SSE stream display + tool call visualization
3. **Workspace view**: File list + upload + delete, switchable from chat view

No router, no build step. Static files served by Worker from `public/`.

### Layout Structure

```
┌─────────────────────────────────────────┐
│ Header: AI Assistant    [Workspace] [⚙] │
├──────────────────┬──────────────────────┤
│                  │                      │
│ Thread List      │   Chat / Workspace   │
│ List (sidebar)   │   (main area)        │
│                  │                      │
│  - Conv 1        │   Messages:          │
│  - Conv 2        │   [user] Hello       │
│  + New Chat      │   [ai] Hi! How can   │
│                  │       I help?        │
│                  │                      │
│                  │   [tool_call badge]  │
│                  │                      │
│                  ├──────────────────────┤
│                  │ Input: [Type...] ▶   │
└──────────────────┴──────────────────────┘
```

### Chat View Features

- Message bubbles: user (right, blue), assistant (left, gray)
- Tool calls shown as collapsible badges: `🔧 web_search("query")` → click to expand result
- SSE streaming: text appears incrementally as it arrives
- Auto-scroll to bottom on new content
- Input: textarea + send button, Enter to send, Shift+Enter for newline

### Workspace View Features

- File list with filename, size, upload date, delete button
- Upload area: drag-and-drop or click to select
- Upload progress bar
- File type icons (PDF, DOC, TXT, MD)

### Thread Management

- Sidebar lists threads (title auto-generated from first message)
- Click to switch thread
- "New Chat" button creates new thread
- Delete thread (X button, confirmation dialog)

### SSE Handling (POST-based)

```javascript
const response = await fetch(`/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
  body: JSON.stringify({ threadId, content: message })
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value);
  // Parse SSE lines: "data: {json}\n\n"
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const event = JSON.parse(line.slice(6));
      // Update DOM based on event.type
    }
  }
}
```

### Error Handling in UI

- Network error: show error banner, retry button
- SSE stream interrupted: show "Connection lost" message, allow retry
- Tool execution error: show in tool_call badge with error styling

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
│   │   ├── d1.ts                # D1 operations (users, tasks, threads, messages, documents, chunks)
│   │   ├── qdrant.ts            # Qdrant operations (upsert, search vectors)
│   │   └── outbox.ts            # Outbox event management
│   ├── services/
│   │   ├── parser.ts            # File parsing (PDF, Word, TXT, MD → text)
│   │   ├── chunker.ts           # Heading-aware chunking (reference: qmd)
│   │   ├── search.ts            # chunks_search: FTS5 + Qdrant hybrid + RRF
│   │   ├── cjk.ts               # CJK tokenization via Intl.Segmenter (reference: qmd)
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
- Qdrant: mock HTTP calls with vitest `vi.fn()` or custom fetch mock
- LLM: mock API responses with vitest `vi.fn()` on LLMClient.chat
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

**Note**: CF Worker has a 10MB uncompressed bundle limit. PDF parsing (`pdf-parse`) and Word parsing (`mammoth`) libraries contribute significantly. If bundle exceeds limit, consider:
- Using lighter alternatives (e.g., `pdfjs-dist` with tree-shaking)
- Offloading heavy parsing to a separate Worker or external service

### Production

```bash
wrangler deploy  # Deploy to CF Worker
wrangler d1 execute xvc-agent2 --file=schema.sql  # Run migrations
```

---

## 14. Reference Projects

- **generic-agent** (`/Users/xmli/me/code/others/generic-agent`): Agent loop pattern, tool dispatch, multi-round orchestration
- **qmd** (`/Users/xmli/me/code/others/qmd`): Hybrid search, RRF fusion, heading-aware chunking, FTS5 integration
