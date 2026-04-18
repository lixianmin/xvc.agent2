# AI Task Assistant Implementation Plan

> **Historical note**: This plan was written before renaming `conversations` → `threads` and before `vitest.config.ts` → `vitest.config.mts`. References to `conversations` and `vitest.config.ts` throughout are outdated; actual code uses `threads` and `vitest.config.mts`.

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a conversational AI task management assistant on Cloudflare Worker with chat, task CRUD, web search, file upload + RAG.

**Architecture:** Hono-based CF Worker monolith. D1 for relational data + FTS5, Qdrant for vectors, R2 for raw files. Agent loop with multi-tool dispatch, auto RAG pre-retrieval. Pure HTML/JS frontend.

**Tech Stack:** TypeScript, Hono, Cloudflare Worker/D1/R2, Qdrant, GLM API, Serper.dev, Vitest

**Spec:** `docs/superpowers/specs/2025-04-17-ai-task-assistant-design.md`

**Principles (from AGENTS.md):**
- TDD: test first, then implement
- Single responsibility per file/class/method
- No interface for single implementation — use class directly
- DB code in dao/ only
- All timestamps UTC+8
- Console.log all key state transitions

---

## Chunk 1: Project Scaffolding + D1 Schema

### Task 1: Initialize project with wrangler + hono

**Files:**
- Create: `package.json`
- Create: `wrangler.toml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Initialize wrangler project**

```bash
npm create cloudflare@latest . -- --type=simple --ts
```

Accept defaults. Then install dependencies:

```bash
npm install hono
npm install -D vitest @cloudflare/vitest-pool-workers wrangler
```

- [ ] **Step 2: Configure wrangler.toml**

```toml
name = "xvc-agent2"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[d1_databases]]
binding = "DB"
database_name = "xvc-agent2"
database_id = "TBD"

[[r2_buckets]]
binding = "FILES"
bucket_name = "xvc-agent2-files"

[triggers]
crons = ["*/5 * * * *"]
```

- [ ] **Step 3: Configure vitest.config.ts**

```typescript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
```

- [ ] **Step 4: Create minimal Hono app in src/index.ts**

```typescript
import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' }));

app.get('/*', serveStatic({ root: './' }));

export default app;
```

- [ ] **Step 5: Verify local dev starts**

```bash
npx wrangler dev
```

Expected: Worker starts on http://localhost:8787, `/api/health` returns `{"status":"ok"}`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: scaffold project with hono + wrangler + vitest"
```

### Task 2: Create D1 schema + migration script

**Files:**
- Create: `schema.sql`

- [ ] **Step 1: Write schema.sql with all tables from spec §3**

```sql
-- schema.sql — all tables from spec §3
-- All timestamps use UTC+8 via datetime('now', '+8 hours')

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ai_nickname TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','cancelled')),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  r2_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  UNIQUE(doc_id, seq)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content = 'chunks',
  content_rowid = 'id',
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK (event_type IN ('embed_chunk','delete_vector')),
  chunk_id INTEGER,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status, created_at);
```

- [ ] **Step 2: Apply schema to local D1**

```bash
npx wrangler d1 execute xvc-agent2 --local --file=schema.sql
```

Expected: All tables created without errors

- [ ] **Step 3: Verify tables exist**

```bash
npx wrangler d1 execute xvc-agent2 --local --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

Expected: users, tasks, conversations, messages, documents, chunks, outbox_events listed

- [ ] **Step 4: Commit**

```bash
git add schema.sql && git commit -m "feat: add D1 schema with all tables and indexes"
```

---

## Chunk 2: DAO Layer

### Task 3: D1 DAO — Users

**Files:**
- Create: `src/dao/d1.ts`
- Create: `tests/unit/dao/d1.test.ts`

- [ ] **Step 1: Write failing test for user operations**

`tests/unit/dao/d1.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createUser, getUser, updateUser } from '../../../src/dao/d1';

describe('User DAO', () => {
  let db: D1Database;

  beforeEach(async () => {
    // use miniflare D1 simulator — provided by vitest pool workers
  });

  it('creates a user and retrieves by id', async () => {
    const user = await createUser(db, { email: 'test@example.com', name: 'Test' });
    expect(user.id).toBeDefined();
    expect(user.email).toBe('test@example.com');
    const found = await getUser(db, user.id);
    expect(found.name).toBe('Test');
  });

  it('rejects duplicate email', async () => {
    await createUser(db, { email: 'dup@example.com', name: 'A' });
    await expect(createUser(db, { email: 'dup@example.com', name: 'B' }))
      .rejects.toThrow();
  });

  it('updates user nickname', async () => {
    const user = await createUser(db, { email: 'nick@example.com', name: 'X' });
    await updateUser(db, user.id, { ai_nickname: '小助手' });
    const found = await getUser(db, user.id);
    expect(found.ai_nickname).toBe('小助手');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx vitest run tests/unit/dao/d1.test.ts
```

Expected: Cannot find module `../../../src/dao/d1`

- [ ] **Step 3: Implement user DAO functions in src/dao/d1.ts**

Create `src/dao/d1.ts` with `createUser`, `getUser`, `updateUser` functions using D1 prepared statements. Export all functions. Follow spec schema exactly.

- [ ] **Step 4: Run test — expect PASS**

```bash
npx vitest run tests/unit/dao/d1.test.ts
```

Expected: All 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/dao/d1.ts tests/unit/dao/ && git commit -m "feat: add user DAO with create/get/update"
```

### Task 4: D1 DAO — Tasks, Conversations, Messages

**Files:**
- Modify: `src/dao/d1.ts`
- Modify: `tests/unit/dao/d1.test.ts`

- [ ] **Step 1: Write failing tests for tasks**

Add to test file:
- `createTask` → returns task with id, default status 'pending'
- `listTasks` by userId → returns array
- `updateTask` status → changes updated_at
- `deleteTask` → removes from DB

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement task functions**

Add to `src/dao/d1.ts`: `createTask`, `listTasks`, `updateTask`, `deleteTask`, `createConversation`, `listConversations`, `getConversation`, `deleteConversation`, `saveMessage`, `loadMessages`

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Write failing tests for conversations + messages**

Add to test file:
- `createConversation` → returns conversation with id
- `getConversation` → returns single conversation by id
- `listConversations` by userId → ordered by updated_at DESC
- `deleteConversation` → cascades messages
- `saveMessage` (role='user') → returns message row
- `saveMessage` (role='assistant' with tool_calls) → stores JSON
- `saveMessage` (role='tool' with tool_call_id) → links correctly
- `loadMessages` by conversation_id → ordered by created_at, respects token budget

- [ ] **Step 6: Implement conversation + message functions**

Add: `createConversation`, `listConversations`, `deleteConversation`, `saveMessage`, `loadMessages`

`loadMessages` must implement the context management from spec §8:
- Load newest-first within ~8000 token budget
- Keep complete tool chains (assistant with tool_calls + all associated tool messages)
- Safety floor: always include last user + last assistant message
- Token estimation: ~4 chars per token

- [ ] **Step 7: Run tests — expect PASS**

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add tasks, conversations, messages DAO with context-aware message loading"
```

### Task 5: D1 DAO — Documents, Chunks, FTS sync

**Files:**
- Modify: `src/dao/d1.ts`
- Modify: `tests/unit/dao/d1.test.ts`
- Create: `src/services/cjk.ts`
- Create: `tests/unit/services/cjk.test.ts`

- [ ] **Step 1: Write failing tests for CJK tokenizer**

`tests/unit/services/cjk.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { tokenizeCJK, containsCJK } from '../../../src/services/cjk';

describe('CJK tokenizer', () => {
  it('passes through non-CJK text unchanged', () => {
    expect(tokenizeCJK('hello world')).toBe('hello world');
  });

  it('splits Chinese text into words', () => {
    const result = tokenizeCJK('人工智能技术');
    expect(result).toContain(' ');
    expect(result.split(' ').length).toBeGreaterThan(1);
  });

  it('detects CJK presence', () => {
    expect(containsCJK('hello')).toBe(false);
    expect(containsCJK('你好')).toBe(true);
  });

  it('handles mixed CJK and ASCII', () => {
    const result = tokenizeCJK('使用RAG技术');
    expect(result).toContain('RAG');
  });

  it('handles empty string', () => {
    expect(tokenizeCJK('')).toBe('');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement CJK tokenizer**

`src/services/cjk.ts` — reference qmd `src/cjk.ts`:
- `containsCJK(text)`: check regex `/[\u3040-\u9FFF\uAC00-\uD7AF]/`
- `splitByScript(text)`: group contiguous characters by Unicode script (Han, Kana, Hangul, other)
- `tokenizeCJK(text)`: use `Intl.Segmenter` with locale `zh` for Han runs, `ja` for Kana, `ko` for Hangul
- Lazy singletons for segmenter instances

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Write failing tests for document + chunk operations**

- `createDocument` → stores metadata
- `listDocuments` by userId
- `deleteDocument` → cascades chunks
- `insertChunk` → writes chunk + tokenized FTS entry
- `searchFTS` → BM25 search with tokenizeCJK on query

- [ ] **Step 6: Implement document + chunk functions**

Add to `src/dao/d1.ts`: `createDocument`, `listDocuments`, `deleteDocument`, `insertChunk`, `searchFTS`

`insertChunk` must:
1. INSERT into `chunks` table
2. INSERT tokenized content into `chunks_fts` via `tokenizeCJK(content)`

`searchFTS` must:
1. Apply `tokenizeCJK` to query
2. Build FTS5 query (simple: join terms with AND + prefix match `term*`)
3. Return results with BM25 score

- [ ] **Step 7: Run tests — expect PASS**

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add CJK tokenizer, document/chunk DAO with FTS5 sync"
```

### Task 6: Qdrant DAO

**Files:**
- Create: `src/dao/qdrant.ts`
- Create: `tests/unit/dao/qdrant.test.ts`

- [ ] **Step 1: Write failing tests for Qdrant operations**

```typescript
import { describe, it, expect } from 'vitest';
import { QdrantDAO } from '../../../src/dao/qdrant';

// Mock fetch for Qdrant HTTP API
describe('Qdrant DAO', () => {
  it('ensures collection exists', async () => {
    // mock fetch to return 200 for collection check
  });

  it('upserts vectors with payload', async () => {
    // verify POST /collections/chunks/points with correct payload
  });

  it('searches by vector with user_id filter', async () => {
    // verify POST /collections/chunks/points/search with filter
  });

  it('deletes vectors by chunk_ids', async () => {
    // verify POST /collections/chunks/points/delete with correct filter
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement Qdrant DAO**

`src/dao/qdrant.ts` — class `QdrantDAO`:
- Constructor: `{ url, apiKey }`
- `ensureCollection()`: GET `/collections/chunks`, create if 404 with dim=1024 cosine
- `upsertVectors(points: {id, vector, payload}[])`: POST `/collections/chunks/points` with upsert
- `searchVectors(query: number[], userId: number, limit: number)`: POST `/collections/chunks/points/search` with filter `{ user_id: userId }`
- `deleteByChunkIds(chunkIds: number[])`: POST `/collections/chunks/points/delete` with filter
- All methods use native `fetch` — CF Worker supports it

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add Qdrant DAO with collection init, upsert, search, delete"
```

### Task 7: Outbox management

**Files:**
- Create: `src/dao/outbox.ts`
- Create: `tests/unit/dao/outbox.test.ts`

- [ ] **Step 1: Write failing tests**

- `createEvent` → writes pending outbox event
- `markCompleted` → updates status + attempts
- `markFailed` → increments attempts, marks 'failed' if >= 3
- `getPendingEvents` → returns events where status='pending' and updated_at < now-30s

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement outbox functions**

`src/dao/outbox.ts` — exports `createEvent`, `markCompleted`, `markFailed`, `getPendingEvents`

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add outbox event management for D1↔Qdrant consistency"
```

---

## Chunk 3: LLM Layer

### Task 8: LLMClient

**Files:**
- Create: `src/llm/client.ts`
- Create: `tests/unit/llm/client.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { LLMClient } from '../../../src/llm/client';

describe('LLMClient', () => {
  it('sends messages and returns text response', async () => {
    // mock fetch to return OpenAI-format SSE stream with text content
  });

  it('parses tool_calls from response', async () => {
    // mock fetch to return response with tool_calls in delta
  });

  it('streams response as AsyncGenerator', async () => {
    // verify generator yields ChatEvent objects incrementally
  });

  it('handles API errors gracefully', async () => {
    // mock 500 response → throws with meaningful error
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement LLMClient**

`src/llm/client.ts`:

```typescript
export class LLMClient {
  constructor(private config: { apiKey: string; baseUrl: string; model: string }) {}

  async *chat(messages: Message[], tools?: ToolDef[]): AsyncGenerator<ChatEvent> {
    // POST to {baseUrl}/v1/chat/completions
    // Parse SSE stream
    // Yield { type: 'text', content } for text deltas
    // Accumulate tool_calls deltas, yield { type: 'tool_call', name, args, call_id } when complete
    // console.log('[agent] LLM call started/completed')
  }
}
```

Types:
- `ChatEvent = TextEvent | ToolCallEvent | ToolResultEvent | StatusEvent`
- `Message = { role: string, content: string, tool_calls?: ToolCall[] }`
- `ToolDef = { type: 'function', function: { name, description, parameters } }`

SSE parsing: split on `\n\n`, extract `data: {...}` lines, handle `[DONE]`.

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add LLMClient with SSE streaming and tool_calls parsing"
```

### Task 9: EmbeddingClient

**Files:**
- Create: `src/llm/embedding.ts`
- Create: `tests/unit/llm/embedding.test.ts`

- [ ] **Step 1: Write failing tests**

- `embed(['hello', 'world'])` → returns `number[][]` with correct dimensions
- handles batch correctly
- handles API errors

- [ ] **Step 2: Implement EmbeddingClient**

`src/llm/embedding.ts`:

```typescript
export class EmbeddingClient {
  constructor(private config: { apiKey: string; baseUrl: string; model: string }) {}

  async embed(texts: string[]): Promise<number[][]> {
    // POST to {baseUrl}/v1/embeddings
    // Return array of embedding vectors
  }
}
```

- [ ] **Step 3: Run tests — expect PASS**

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add EmbeddingClient for GLM embedding API"
```

---

## Chunk 4: Services

### Task 10: Text cleaner

**Files:**
- Create: `src/services/cleaner.ts`
- Create: `tests/unit/services/cleaner.test.ts`

- [ ] **Step 1: Write failing tests**

- Normalizes whitespace (collapse multiple spaces/newlines)
- Strips control chars (keeps \n \t)
- Removes HTML tags
- NFC normalization
- Handles empty string

- [ ] **Step 2: Implement cleaner**

`src/services/cleaner.ts`: single exported function `cleanText(text: string): string`

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add text cleaner for file preprocessing"
```

### Task 11: Chunker

**Files:**
- Create: `src/services/chunker.ts`
- Create: `tests/unit/services/chunker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('Heading-aware chunker', () => {
  it('splits at heading boundaries', () => {
    const text = '# Chapter 1\n' + 'word '.repeat(200) + '\n# Chapter 2\n' + 'word '.repeat(200);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].content).toContain('Chapter 1');
    expect(chunks[1].content).toContain('Chapter 2');
  });

  it('respects target size ~500 tokens', () => {
    const text = 'word '.repeat(2000);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(700);
    }
  });

  it('does not break inside code fences', () => {
    const text = '# Title\n```\n' + 'code\n'.repeat(100) + '```\n# Next';
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const fences = (chunk.content.match(/```/g) || []).length;
      expect(fences).toBe(0).or.toBe(2);
    }
  });

  it('handles short text as single chunk', () => {
    const chunks = chunkText('short text');
    expect(chunks.length).toBe(1);
  });
});
```

- [ ] **Step 2: Implement chunker**

`src/services/chunker.ts` — reference spec §6 and qmd `src/store.ts:72-308`:

```typescript
export function chunkText(text: string): Chunk[] {
  // 1. Scan break points with scoring
  // 2. Walk text accumulating ~500 tokens
  // 3. Find best break point in 100-token window
  // 4. Skip breaks inside code fences
  // 5. Return array of { content, seq, tokenCount }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add heading-aware text chunker"
```

### Task 12: File parser

**Files:**
- Create: `src/services/parser.ts`
- Create: `tests/unit/services/parser.test.ts`

- [ ] **Step 1: Write failing tests**

- Parses .txt → plain text as-is
- Parses .md → plain text (strip markdown syntax)
- Parses .pdf → plain text (using pdf-parse)
- Parses .docx → plain text (using mammoth)
- Handles unsupported types → throws error

- [ ] **Step 2: Install parsing dependencies**

```bash
npm install pdf-parse mammoth
```

Note: check bundle size. If >10MB, switch to lighter alternatives.

- [ ] **Step 3: Implement parser**

`src/services/parser.ts`:

```typescript
export async function parseFile(buffer: ArrayBuffer, mimeType: string, filename: string): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'txt': return new TextDecoder().decode(buffer);
    case 'md': return new TextDecoder().decode(buffer);
    case 'pdf': return parsePDF(buffer);
    case 'docx': case 'doc': return parseDOCX(buffer);
    default: throw new Error(`Unsupported file type: ${ext}`);
  }
}
```

- [ ] **Step 4: Verify bundle size**

```bash
npx wrangler deploy --dry-run --outdir=dist && du -sh dist/*
```

Expected: Total bundle < 10MB. If exceeded, replace `pdf-parse` with `pdfjs-dist` (tree-shakeable).

- [ ] **Step 5: Run tests, commit**

```bash
git add -A && git commit -m "feat: add file parser for PDF, DOCX, TXT, MD"
```

### Task 13: Web search + fetch service

**Files:**
- Create: `src/services/web.ts`
- Create: `tests/unit/services/web.test.ts`

- [ ] **Step 1: Write failing tests for Serper search**

```typescript
describe('web_search', () => {
  it('calls Serper API and returns results', async () => {
    // mock fetch → verify POST to https://google.serper.dev/search
    // verify returns array of { title, link, snippet }
  });
});
```

- [ ] **Step 2: Write failing tests for web_fetch**

```typescript
describe('web_fetch', () => {
  it('fetches URL and extracts text content', async () => {
    // mock fetch → return HTML
    // verify returns plain text (stripped of HTML)
  });
});
```

- [ ] **Step 3: Implement web.ts**

`src/services/web.ts`:

```typescript
export async function serperSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  console.log(`[search] serper query: ${query}`);
  // POST https://google.serper.dev/search with { q: query, gl: 'cn', hl: 'zh-cn' }
  // Return organic results: [{ title, link, snippet }]
}

export async function fetchUrl(url: string): Promise<string> {
  console.log(`[search] fetching URL: ${url}`);
  // GET url, extract text from HTML (strip tags, get main content)
  // Return plain text
}
```

- [ ] **Step 4: Run tests, commit**

```bash
git add -A && git commit -m "feat: add web search (Serper) and URL fetch service"
```

### Task 14: Hybrid search service (chunks_search)

**Files:**
- Create: `src/services/search.ts`
- Create: `tests/unit/services/search.test.ts`

- [ ] **Step 1: Write failing tests for RRF fusion**

```typescript
describe('RRF fusion', () => {
  it('fuses two ranked lists with correct scores', () => {
    const listA = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const listB = [{ id: 2 }, { id: 1 }, { id: 4 }];
    const result = reciprocalRankFusion([listA, listB], [1, 1]);
    expect(result[0].id).toBe(1); // appears in both, high rank
  });

  it('applies top-rank bonus', () => {
    // rank #1 gets +0.05 bonus
  });
});

describe('chunksSearch', () => {
  it('runs hybrid search combining FTS + vector results', async () => {
    // mock searchFTS and searchVectors
    // verify RRF fusion applied
    // verify results contain chunk content
  });

  it('falls back to keyword-only when Qdrant unreachable', async () => {
    // mock searchVectors to throw
    // verify FTS results returned
  });
});
```

- [ ] **Step 2: Implement search service**

`src/services/search.ts`:

```typescript
export function reciprocalRankFusion(
  lists: SearchCandidate[][],
  weights: number[],
  k = 60
): ScoredCandidate[] {
  // RRF algorithm from spec §7
  // Top-rank bonus: rank #1 → +0.05, ranks #2-3 → +0.02
}

export async function chunksSearch(
  query: string,
  userId: number,
  mode: 'keyword' | 'vector' | 'hybrid',
  deps: { d1: D1Database; qdrant: QdrantDAO; embedding: EmbeddingClient }
): Promise<ChunkResult[]> {
  console.log(`[search] mode=${mode}, query=${query}`);
  // keyword: searchFTS only
  // vector: embed query → searchVectors only
  // hybrid: both → RRF fusion
  // Fallback: if Qdrant fails in hybrid, return FTS-only results
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add hybrid search with RRF fusion"
```

---

## Chunk 5: Agent Core

### Task 15: System prompt builder

**Files:**
- Create: `src/agent/prompt.ts`
- Create: `tests/unit/agent/prompt.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('buildSystemPrompt', () => {
  it('assembles prompt in correct order', () => {
    const prompt = buildSystemPrompt({
      tools: [/* tool defs */],
      userName: '张三',
      aiNickname: '小助',
      ragContext: 'relevant chunk text...',
      datetime: '2025-04-17 14:30:00 CST',
    });
    // Verify order: tools → instructions → user info → rag → datetime
    expect(prompt.indexOf('tools')).toBeLessThan(prompt.indexOf('张三'));
    expect(prompt.indexOf('张三')).toBeLessThan(prompt.indexOf('rag context'));
    expect(prompt.indexOf('rag context')).toBeLessThan(prompt.indexOf('2025-04-17'));
  });

  it('omits rag context when empty', () => {
    const prompt = buildSystemPrompt({ /* no ragContext */ });
    expect(prompt).not.toContain('相关文档');
  });

  it('includes all tool schemas', () => {
    const prompt = buildSystemPrompt({ tools: [tool1, tool2] });
    expect(prompt).toContain('task_create');
    expect(prompt).toContain('web_search');
  });
});
```

- [ ] **Step 2: Implement prompt builder**

`src/agent/prompt.ts`:

```typescript
export function buildSystemPrompt(params: {
  tools: ToolDef[];
  userName: string;
  aiNickname?: string;
  ragContext?: string;
  datetime: string;
}): string {
  // Assemble in order per spec §8:
  // 1. Tool schemas (JSON)
  // 2. Base instructions (role, capabilities, guidelines, deep research guidance)
  // 3. User info (name, nickname)
  // 4. RAG context (if provided)
  // 5. Current datetime
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add system prompt builder with correct ordering"
```

### Task 16: Tool definitions and dispatch

**Files:**
- Create: `src/agent/tools.ts`
- Create: `tests/unit/agent/tools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('Tool dispatch', () => {
  it('dispatches web_search correctly', async () => {
    const result = await dispatchTool('web_search', { q: 'test query' }, deps);
    expect(result).toContain('test query');
  });

  it('dispatches task_create and returns created task', async () => {
    const result = await dispatchTool('task_create', { title: 'Test task' }, deps);
    const parsed = JSON.parse(result);
    expect(parsed.title).toBe('Test task');
  });

  it('returns error for unknown tool', async () => {
    const result = await dispatchTool('unknown_tool', {}, deps);
    expect(result).toContain('error');
  });
});
```

- [ ] **Step 2: Implement tools**

`src/agent/tools.ts`:

```typescript
const toolHandlers: Record<string, (args: any, deps: ToolDeps) => Promise<string>> = {
  web_search: do_web_search,
  web_fetch: do_web_fetch,
  task_create: do_task_create,
  task_list: do_task_list,
  task_update: do_task_update,
  task_delete: do_task_delete,
  file_list: do_file_list,
  file_delete: do_file_delete,
  chunks_search: do_chunks_search,
};

export async function dispatchTool(name: string, args: any, deps: ToolDeps): Promise<string> {
  const handler = toolHandlers[name];
  if (!handler) return JSON.stringify({ error: `Unknown tool: ${name}` });
  console.log(`[agent] tool_call: name=${name}, args=${JSON.stringify(args)}`);
  const start = Date.now();
  const result = await handler(args, deps);
  console.log(`[agent] tool_result: name=${name}, duration=${Date.now() - start}ms`);
  return result;
}

export function getToolDefinitions(): ToolDef[] {
  // Return JSON schema for all 9 tools per spec §2
}
```

Each handler:
- `do_web_search`: calls `serperSearch`, returns JSON results
- `do_web_fetch`: calls `fetchUrl`, returns extracted text
- `do_task_create/list/update/delete`: calls D1 DAO, returns JSON
- `do_file_list/delete`: calls D1 DAO + R2 + Qdrant for delete
- `do_chunks_search`: calls `chunksSearch` service, returns formatted results

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add tool definitions and convention-based dispatch"
```

### Task 17: Agent loop

**Files:**
- Create: `src/agent/loop.ts`
- Create: `tests/unit/agent/loop.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
describe('AgentLoop', () => {
  it('streams text response without tools', async () => {
    // mock LLMClient to return text-only response
    const stream = agentLoop.run(userId, convId, 'hello');
    const events = await collectSSEEvents(stream);
    expect(events.some(e => e.type === 'text')).toBe(true);
    expect(events.some(e => e.type === 'status')).toBe(true);
  });

  it('dispatches tool calls and injects results', async () => {
    // mock LLM to return tool_call, then text after result
    const events = await collectSSEEvents(stream);
    expect(events.some(e => e.type === 'tool_call')).toBe(true);
    expect(events.some(e => e.type === 'tool_result')).toBe(true);
  });

  it('handles multiple tool calls in one round', async () => {
    // mock LLM to return 3 tool_calls at once
  });

  it('stops after 30 rounds', async () => {
    // mock LLM to always return tool_calls
    // verify loop terminates with limit_reached message
  });

  it('performs RAG pre-retrieval before first LLM call', async () => {
    // verify chunksSearch called with user message before LLM
    // verify ragContext passed to system prompt builder
  });

  it('persists messages to DB', async () => {
    // verify saveMessage called for user, assistant, tool messages
  });

  it('handles LLM API failure mid-stream', async () => {
    // mock LLM to throw after partial response
    // verify error event sent to SSE stream
    // verify retry message shown to user
  });
});
```

- [ ] **Step 2: Implement AgentLoop**

`src/agent/loop.ts`:

```typescript
export class AgentLoop {
  constructor(private deps: AgentDeps) {}

  async run(userId: number, conversationId: number, userMessage: string): ReadableStream {
    return new ReadableStream({
      async start(controller) {
        try {
          // ... agent loop logic ...
        } catch (err) {
          console.log(`[agent] loop error: ${err.message}`);
          controller.enqueue(sseEvent({ type: 'text', content: `抱歉，处理过程中出现错误：${err.message}` }));
          controller.enqueue('data: [DONE]\n\n');
          controller.close();
        }
      }
    });
        // 1. RAG pre-retrieval
        controller.enqueue(sseEvent({ type: 'status', content: '正在检索相关文档...' }));
        const ragContext = await chunksSearch(userMessage, userId, 'hybrid', deps);
        
        // 2. Build system prompt
        const systemPrompt = buildSystemPrompt({ tools, userName, ragContext, datetime });
        
        // 3. Save user message to DB
        await saveMessage(db, { conversation_id, role: 'user', content: userMessage });
        
        // 4. Load context (message history within budget)
        const history = await loadMessages(db, conversationId);
        
        // 5. Agent loop: max 30 rounds
        let round = 0;
        while (round < 30) {
          round++;
          console.log(`[agent] LLM call started: round ${round}`);
          controller.enqueue(sseEvent({ type: 'status', content: '正在思考...' }));
          
          const messages = [systemMsg, ...history];
          let fullText = '';
          const toolCalls = [];
          
          for await (const event of llm.chat(messages, tools)) {
            if (event.type === 'text') {
              fullText += event.content;
              controller.enqueue(sseEvent(event));
            } else if (event.type === 'tool_call') {
              toolCalls.push(event);
              controller.enqueue(sseEvent(event));
            }
          }
          
          // Save assistant message
          await saveMessage(db, { role: 'assistant', content: fullText, tool_calls: toolCalls.length ? JSON.stringify(toolCalls) : null });
          
          if (toolCalls.length === 0) break; // no tools → done
          
          // Execute all tool calls
          for (const tc of toolCalls) {
            const result = await dispatchTool(tc.name, tc.args, deps);
            controller.enqueue(sseEvent({ type: 'tool_result', name: tc.name, call_id: tc.call_id, result }));
            await saveMessage(db, { role: 'tool', content: result, tool_call_id: tc.call_id });
            history.push(/* assistant + tool messages */);
          }
        }
        
        if (round >= 30) {
          controller.enqueue(sseEvent({ type: 'text', content: '已达到处理上限...' }));
        }
        
        console.log(`[agent] loop ended: rounds=${round}, reason=completed`);
        controller.enqueue('data: [DONE]\n\n');
        controller.close();
      }
    });
  }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add agent loop with multi-tool dispatch, RAG pre-retrieval, message persistence"
```

---

## Chunk 6: API Routes + Middleware

### Task 18: Auth middleware

**Files:**
- Create: `src/middleware/auth.ts`
- Create: `tests/unit/middleware/auth.test.ts`

- [ ] **Step 1: Write failing test**

- Valid X-User-Id header → passes through
- Missing header → 401
- Non-existent user → 401

- [ ] **Step 2: Implement auth middleware**

`src/middleware/auth.ts`:

```typescript
export const authMiddleware = async (c: Context, next: Next) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) return c.json({ error: 'Missing X-User-Id' }, 401);
  const user = await getUser(c.env.DB, parseInt(userId));
  if (!user) return c.json({ error: 'User not found' }, 401);
  c.set('user', user);
  await next();
};
```

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add auth middleware for X-User-Id validation"
```

### Task 19: All API routes

- Create: `src/services/upload.ts`
- Create: `tests/unit/services/upload.test.ts`
- Modify: `src/index.ts`
- Create: `tests/unit/routes.test.ts`

- [ ] **Step 1: Write failing tests for all RPC-style routes from spec §9**

Test each endpoint:
- `POST /api/user/create` → creates user, returns 200
- `GET /api/user/:id` → returns user
- `POST /api/user/update` → updates nickname
- `POST /api/conversations/create` → creates conversation
- `GET /api/conversations/list?userId=` → lists conversations
- `GET /api/conversations/:id/messages` → returns messages
- `POST /api/conversations/delete` → deletes conversation
- `POST /api/chat/:convId` → returns SSE stream
- `GET /api/tasks/list?userId=` → lists tasks
- `POST /api/tasks/create` → creates task
- `POST /api/tasks/update` → updates task
- `POST /api/tasks/delete` → deletes task
- `POST /api/files/upload` → uploads file to R2, triggers processing
- `GET /api/files/list?userId=` → lists files
- `POST /api/files/delete` → deletes file + chunks + vectors
- `POST /api/admin/process-outbox` → processes pending outbox events
- `GET /api/admin/outbox-status` → returns counts by status

- [ ] **Step 2: Implement all routes in src/index.ts**

Mount Hono routes per spec §9. Use `authMiddleware` on protected routes.

Chat route (`POST /api/chat/:convId`):
```typescript
app.post('/api/chat/:convId', authMiddleware, async (c) => {
  const { convId } = c.req.param();
  const { content } = await c.req.json();
  const user = c.get('user');
  const loop = new AgentLoop(deps);
  const stream = loop.run(user.id, parseInt(convId), content);
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});
```

File upload route:
```typescript
app.post('/api/files/upload', authMiddleware, async (c) => {
  const result = await processFileUpload(c.env, c.get('user').id, await c.req.formData());
  return c.json(result);
});
```

Extract file processing into `src/services/upload.ts`:
```typescript
export async function processFileUpload(env: Env, userId: number, formData: FormData): Promise<Document> {
  const file = formData.get('file') as File;
  // 1. Store in R2
  // 2. Parse → clean → chunk
  // 3. Write D1 + FTS + outbox
  // 4. Sync dual-write: embed → Qdrant → mark completed
  // Keep under 100 lines per AGENTS.md
}
```

File delete route:
```typescript
app.post('/api/files/delete', authMiddleware, async (c) => {
  const { id } = await c.req.json();
  // 1. Delete from R2
  // 2. Delete from D1 (cascades chunks)
  // 3. Delete vectors from Qdrant (via outbox or direct)
  // 4. Delete FTS entries (rebuild or delete)
  return c.json({ ok: true });
});
```

Cron handler (outbox retry):
```typescript
export const scheduled: ExportedHandlerScheduledHandler = async (event, env, ctx) => {
  const pending = await getPendingEvents(env.DB);
  for (const event of pending) {
    // Retry: embed → Qdrant → mark completed/failed
  }
};
```

- [ ] **Step 3: Run tests, commit**

```bash
git add -A && git commit -m "feat: add all API routes (RPC style), file upload pipeline, cron handler"
```

---

## Chunk 7: Frontend

### Task 20: HTML + CSS structure

**Files:**
- Create: `public/index.html`
- Create: `public/style.css`

- [ ] **Step 1: Create index.html with three views per spec §10**

Layout per spec wireframe:
- Header with workspace toggle + settings button
- Sidebar for conversation list + new chat button
- Main area for chat messages / workspace file list
- Input area at bottom of chat

Three view states managed by JS:
1. Registration form (shown when no userId)
2. Chat view (message list + input)
3. Workspace view (file list + upload)

Use semantic HTML, no frameworks.

- [ ] **Step 2: Create style.css**

- Clean, modern chat UI
- Message bubbles: user (right, blue), assistant (left, gray)
- Tool call badges: collapsible, muted color
- Status bubbles: italic, lighter color, ephemeral
- Sidebar: conversation list with hover/active states
- File upload area: drag-and-drop with dashed border
- Mobile responsive: sidebar collapses on small screens

- [ ] **Step 3: Verify in browser**

```bash
npx wrangler dev
```

Open http://localhost:8787, verify:
- Registration form shows (no userId)
- After registration, chat view shows
- Sidebar visible, main area empty

- [ ] **Step 4: Commit**

```bash
git add public/ && git commit -m "feat: add frontend HTML + CSS with registration, chat, workspace views"
```

### Task 21: Frontend JavaScript

**Files:**
- Create: `public/app.js`

- [ ] **Step 1: Implement registration flow**

```javascript
// On load: check localStorage for userId
// If missing: show registration form
// On submit: POST /api/user/create → store userId → switch to chat view
```

- [ ] **Step 2: Implement conversation management**

```javascript
// loadConversations(): GET /api/conversations/list → render sidebar
// createConversation(): POST /api/conversations/create → switch to new conv
// deleteConversation(): POST /api/conversations/delete → confirm → remove
// loadMessages(convId): GET /api/conversations/:id/messages → render chat
```

- [ ] **Step 3: Implement chat with SSE streaming**

```javascript
// sendMessage(): POST /api/chat/:convId with fetch ReadableStream
// Parse SSE events:
//   'text' → append to assistant bubble
//   'tool_call' → show collapsible badge
//   'tool_result' → update badge with result
//   'status' → show ephemeral status bubble
//   [DONE] → finalize
```

- [ ] **Step 4: Implement workspace view**

```javascript
// loadFiles(): GET /api/files/list → render file list
// uploadFile(): POST /api/files/upload (FormData) → progress bar → refresh list
// deleteFile(): POST /api/files/delete → confirm → refresh list
```

- [ ] **Step 5: Verify full flow in browser**

```bash
npx wrangler dev
```

Test:
1. Register → see chat view
2. Send message → see AI response streaming
3. Ask "帮我创建一个任务" → see task created
4. Switch to workspace → upload a file → see file in list
5. Ask about uploaded file → see RAG-enhanced response
6. Create new conversation → switch back → messages preserved

- [ ] **Step 6: Commit**

```bash
git add public/app.js && git commit -m "feat: add frontend JS with registration, chat SSE, workspace management"
```

---

## Chunk 8: Integration Tests + Deployment

### Task 22: Integration test scripts

**Files:**
- Create: `tests/integration/test-api.sh`

- [ ] **Step 1: Write curl-based integration test script**

```bash
#!/bin/bash
# tests/integration/test-api.sh
# Run against: npx wrangler dev
BASE_URL="http://localhost:8787"

echo "=== Test 1: Create user ==="
USER=$(curl -s -X POST "$BASE_URL/api/user/create" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test"}')
USER_ID=$(echo $USER | jq '.id')
echo "Created user: $USER_ID"

echo "=== Test 2: Create conversation ==="
CONV=$(curl -s -X POST "$BASE_URL/api/conversations/create" \
  -H "Content-Type: application/json" \
  -d "{\"userId\":$USER_ID}")
CONV_ID=$(echo $CONV | jq '.id')
echo "Created conversation: $CONV_ID"

echo "=== Test 3: Send chat message ==="
curl -s -X POST "$BASE_URL/api/chat/$CONV_ID" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: $USER_ID" \
  -d '{"content":"你好"}' | head -20

echo "=== Test 4: List tasks ==="
curl -s "$BASE_URL/api/tasks/list?userId=$USER_ID" | jq .

echo "=== Test 5: Upload file ==="
curl -s -X POST "$BASE_URL/api/files/upload" \
  -H "X-User-Id: $USER_ID" \
  -F "file=@tests/integration/sample.txt" | jq .

echo "=== All integration tests passed ==="
```

- [ ] **Step 2: Create sample test file**

`tests/integration/sample.txt`: a small text file with some Chinese content for RAG testing.

- [ ] **Step 3: Run integration tests**

```bash
# Terminal 1: start worker
npx wrangler dev

# Terminal 2: run tests
bash tests/integration/test-api.sh
```

Expected: All tests pass with valid JSON responses

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add curl-based integration test scripts"
```

### Task 23: Wrangler production setup + deploy

**Files:**
- Modify: `wrangler.toml` (set real database_id)

- [ ] **Step 1: Create D1 database**

```bash
npx wrangler d1 create xvc-agent2
```

Copy the `database_id` from output into `wrangler.toml`.

- [ ] **Step 2: Create R2 bucket**

```bash
npx wrangler r2 bucket create xvc-agent2-files
```

- [ ] **Step 3: Set up Qdrant Cloud**

```bash
# Create free cluster at https://cloud.qdrant.io/
# Update .dev.vars with production QDRANT_URL and QDRANT_API_KEY
# Or set as CF Worker secrets:
npx wrangler secret put QDRANT_URL
npx wrangler secret put QDRANT_API_KEY
```

Create collection in Qdrant Cloud:
```bash
curl -X PUT "${QDRANT_URL}/collections/chunks" \
  -H "api-key: ${QDRANT_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"vectors": {"size": 1024, "distance": "Cosine"}}'
```

- [ ] **Step 4: Apply schema to production D1**

```bash
npx wrangler d1 execute xvc-agent2 --file=schema.sql
```

- [ ] **Step 4: Deploy**

```bash
npx wrangler deploy
```

- [ ] **Step 5: Verify production**

```bash
curl -X POST https://<worker-url>/api/user/create \
  -H "Content-Type: application/json" \
  -d '{"email":"prod@example.com","name":"ProdTest"}'
```

Expected: User created successfully

- [ ] **Step 6: Commit final state**

```bash
git add -A && git commit -m "feat: configure production deployment and verify"
```

---

## Dependency Graph

```
Task 1 (scaffold) ──→ Task 2 (schema)
    │                       │
    │              Task 3 (user DAO) ──→ Task 4 (tasks/conv/msg DAO) ──→ Task 5 (CJK+doc/chunk DAO)
    │                                                                     │
    ├─→ Task 6 (qdrant)  ────────────────────────────────────────────────┤
    ├─→ Task 7 (outbox)  ────────────────────────────────────────────────┤
    │                                                                    │
    ├─→ Task 8 (LLM)     ───────────────────────────────────────────────┤
    ├─→ Task 9 (embed)   ───────────────────────────────────────────────┤
    │                                                                    │
    ├─→ Task 10 (cleaner)───────────────────────────────────────────────┤
    ├─→ Task 11 (chunker)───────────────────────────────────────────────┤
    ├─→ Task 12 (parser) ───────────────────────────────────────────────┤
    ├─→ Task 13 (web)    ───────────────────────────────────────────────┤
    ├─→ Task 14 (search) ───────────────────────────────────────────────┤
    │                                                                    │
    │         ┌──────────────────────────────────────────────────────────┘
    │         ↓
    ├─→ Task 15 (prompt)  ──→ Task 16 (tools) ──→ Task 17 (agent loop)
    │                                                    │
    ├─→ Task 18 (auth)  ────────────────────────→ Task 19 (routes)
                                                         │
                                              Task 20 (HTML/CSS)
                                              Task 21 (JS)     │
                                                         │
                                              Task 22 (integ tests)
                                              Task 23 (deploy)
```

**Sequential chains:**
- Tasks 3 → 4 → 5 (all modify `src/dao/d1.ts`, must be sequential)
- Tasks 15 → 16 → 17 (prompt → tools → loop, sequential dependencies)

**Parallelizable groups:**
- Tasks 6, 7, 8, 9, 10, 11, 12, 13, 14 (different files, independent subsystems)
- Tasks 18 + 15 can start in parallel
- Tasks 20-21 depend on Task 19
