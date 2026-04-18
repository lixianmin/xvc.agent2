# Agent Memory (memory_save) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `memory_save` tool so the Agent can persist key user information during conversation, retrievable via hybrid search in future sessions.

**Architecture:** Reuse existing chunks table (source='chat', doc_id=NULL) + Qdrant vectors. Agent calls memory_save tool during conversation. Dedup via cosine similarity > 0.95 against existing chat memories. Synchronous dual-write (no outbox). Expiration by category (fact=never, preference=180d, plan=7d).

**Tech Stack:** Existing: D1, Qdrant, EmbeddingClient (bge-m3), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2025-04-17-agent-memory-design.md`

**Known spec corrections (apply during implementation):**
- `String(chunk.id)` → use numeric ID directly (Qdrant rejects string numerics)
- Schema already has `source`, `expires_at`, `created_at` columns; `doc_id` already nullable — no migration needed

---

## Chunk 1: D1 DAO Layer

### Task 1: Add `insertChatMemory` and `updateChatMemory` to d1.ts

**Files:**
- Modify: `src/dao/d1.ts`
- Test: `tests/unit/dao/d1.test.ts`

- [ ] **Step 1: Write failing test for `insertChatMemory`**

Add to `tests/unit/dao/d1.test.ts`:

```typescript
it('inserts a chat memory with source=chat', async () => {
  const chunk = await insertChatMemory(db, {
    userId,
    content: '用户偏好用中文交流',
    category: 'preference',
  });
  expect(chunk).toBeTruthy();
  expect(chunk!.source).toBe('chat');
  expect(chunk!.doc_id).toBeNull();
  expect(chunk!.content).toBe('用户偏好用中文交流');
  expect(chunk!.expires_at).toBeTruthy();
});

it('inserts a fact memory with no expiration', async () => {
  const chunk = await insertChatMemory(db, {
    userId,
    content: '用户名叫小明',
    category: 'fact',
  });
  expect(chunk!.expires_at).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dao/d1.test.ts`
Expected: FAIL — `insertChatMemory` is not defined

- [ ] **Step 3: Implement `insertChatMemory` and helper `getExpiresAt`**

Add to `src/dao/d1.ts`:

```typescript
export type ChatMemoryInput = {
  userId: number;
  content: string;
  category: string;
};

function getExpiresAt(category: string): string | null {
  const fmt = (ms: number) => {
    const d = new Date(Date.now() + ms + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  };
  if (category === 'fact') return null;
  if (category === 'preference') return fmt(180 * 86400 * 1000);
  return fmt(7 * 86400 * 1000);
}

export async function insertChatMemory(db: D1Database, input: ChatMemoryInput): Promise<Chunk | null> {
  const expiresAt = getExpiresAt(input.category);
  const tokenized = tokenizeCJK(input.content);
  const tokenCount = estimateTokens(input.content);
  const result = await db.batch([
    db.prepare('INSERT INTO chunks (doc_id, user_id, seq, content, token_count, source, expires_at) VALUES (NULL, ?, 0, ?, ?, ?, ?)')
      .bind(input.userId, input.content, tokenCount, 'chat', expiresAt),
    db.prepare('INSERT INTO chunks_fts (rowid, content) VALUES (last_insert_rowid(), ?)').bind(tokenized),
  ]);
  const id = result[0].meta.last_row_id as number;
  return db.prepare('SELECT * FROM chunks WHERE id = ?').bind(id).first<Chunk>()!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/dao/d1.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for `updateChatMemory`**

Add to `tests/unit/dao/d1.test.ts`:

```typescript
it('updates chat memory content and expires_at', async () => {
  const chunk = await insertChatMemory(db, {
    userId,
    content: '用户喜欢 Python',
    category: 'preference',
  });
  const updated = await updateChatMemory(db, chunk!.id, {
    content: '用户喜欢 TypeScript',
    category: 'fact',
  });
  expect(updated).toBeTruthy();
  const row = await db.prepare('SELECT content, source, expires_at FROM chunks WHERE id = ?').bind(chunk!.id).first<any>();
  expect(row.content).toBe('用户喜欢 TypeScript');
  expect(row.expires_at).toBeNull();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/unit/dao/d1.test.ts`
Expected: FAIL — `updateChatMemory` is not defined

- [ ] **Step 7: Implement `updateChatMemory`**

Add to `src/dao/d1.ts`:

```typescript
export type UpdateChatMemoryInput = {
  content: string;
  category: string;
};

export async function updateChatMemory(db: D1Database, id: number, input: UpdateChatMemoryInput): Promise<boolean> {
  const expiresAt = getExpiresAt(input.category);
  const tokenized = tokenizeCJK(input.content);
  const result = await db.batch([
    db.prepare('UPDATE chunks SET content = ?, expires_at = ? WHERE id = ?')
      .bind(input.content, expiresAt, id),
    db.prepare('INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES(?, ?, ?)')
      .bind('delete', id, ''),
    db.prepare('INSERT INTO chunks_fts(rowid, content) VALUES(?, ?)')
      .bind(id, tokenized),
  ]);
  return result[0].meta.changes > 0;
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/unit/dao/d1.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/dao/d1.ts tests/unit/dao/d1.test.ts
git commit -m "feat(d1): add insertChatMemory and updateChatMemory for memory_save"
```

---

### Task 2: Add expiration filter to `searchFTS`

**Files:**
- Modify: `src/dao/d1.ts`
- Test: `tests/unit/dao/d1.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/unit/dao/d1.test.ts`:

```typescript
it('searchFTS excludes expired chat memories', async () => {
  await insertChatMemory(db, { userId, content: '过期记忆关键词唯一标识xyz', category: 'plan' });
  await db.prepare("UPDATE chunks SET expires_at = datetime('now', '+8 hours', '-1 day') WHERE source = 'chat'").run();
  const results = await searchFTS(db, '过期记忆关键词唯一标识xyz', 10);
  expect(results.length).toBe(0);
});

it('searchFTS includes non-expired chat memories', async () => {
  await insertChatMemory(db, { userId, content: '有效记忆关键词唯一标识abc', category: 'fact' });
  const results = await searchFTS(db, '有效记忆关键词唯一标识abc', 10);
  expect(results.length).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dao/d1.test.ts`
Expected: FAIL — expired memory still returned

- [ ] **Step 3: Update `searchFTS` SQL to filter expired chat memories**

Change the WHERE clause in `src/dao/d1.ts` `searchFTS`:

```typescript
export async function searchFTS(db: D1Database, query: string, limit = 20): Promise<FTSResult[]> {
  const tokenized = tokenizeCJK(query);
  const terms = tokenized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const ftsQuery = terms.map((t) => `${t}*`).join(' AND ');
  const result = await db
    .prepare(
      `SELECT c.id, c.content, c.doc_id, bm25(chunks_fts) AS score
       FROM chunks_fts f JOIN chunks c ON f.rowid = c.id
       WHERE chunks_fts MATCH ?
         AND (c.source = 'document' OR (c.source = 'chat' AND (c.expires_at IS NULL OR c.expires_at > datetime('now', '+8 hours'))))
       ORDER BY score LIMIT ?`,
    )
    .bind(ftsQuery, limit)
    .all<FTSResult>();
  return result.results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/dao/d1.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dao/d1.ts tests/unit/dao/d1.test.ts
git commit -m "feat(searchFTS): filter out expired chat memories"
```

---

## Chunk 2: Qdrant + Tool Layer

### Task 3: Add source/expiration filter to Qdrant searchVectors

**Files:**
- Modify: `src/dao/qdrant.ts`
- Test: `tests/unit/dao/qdrant.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/unit/dao/qdrant.test.ts`:

```typescript
it('searchVectors includes source/expiration filter for chat memories', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ result: {} }) });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ result: [{ id: 1, score: 0.9, payload: { chunk_id: 1, source: 'chat' } }] }),
  });
  await dao.searchVectors([0.1], 1, 5);
  const body = JSON.parse(fetchMock.mock.calls[1][1].body);
  const shouldClauses = body.filter.must.find((c: any) => 'should' in c);
  expect(shouldClauses).toBeDefined();
  expect(shouldClauses.should.length).toBeGreaterThanOrEqual(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/dao/qdrant.test.ts`
Expected: FAIL — current filter only has `user_id`

- [ ] **Step 3: Update `searchVectors` filter**

Change `src/dao/qdrant.ts` `searchVectors`:

```typescript
async searchVectors(query: number[], userId: number, limit: number, withVector = false): Promise<SearchResult[]> {
  await this.ensureCollection();
  const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').replace('Z', '');
  const body: Record<string, unknown> = {
    vector: query,
    filter: {
      must: [
        { key: 'user_id', match: { value: userId } },
        {
          should: [
            { key: 'source', match: { value: 'document' } },
            {
              must: [
                { key: 'source', match: { value: 'chat' } },
                { is_empty: { key: 'expires_at' } },
              ],
            },
            {
              must: [
                { key: 'source', match: { value: 'chat' } },
                { range: { key: 'expires_at', gt: now } },
              ],
            },
          ],
        },
      ],
    },
    limit,
    with_payload: true,
  };
  if (withVector) body.with_vector = true;
  const res = await fetch(this.collectionUrl('/points/search'), {
    method: 'POST',
    headers: this.headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Qdrant search failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/dao/qdrant.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dao/qdrant.ts tests/unit/dao/qdrant.test.ts
git commit -m "feat(qdrant): add source/expiration filter for chat memories"
```

---

### Task 4: Add `memory_save` tool definition and handler

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `tests/unit/agent/tools.test.ts`

- [ ] **Step 1: Write failing test for `do_memory_save`**

Add to `tests/unit/agent/tools.test.ts`:

```typescript
it('memory_save inserts new chat memory', async () => {
  mockEmbedding.embed.mockResolvedValueOnce([[0.1, 0.2, 0.3]]);
  mockQdrant.searchVectors.mockResolvedValueOnce([]);

  const result = await dispatchTool('memory_save', {
    items: [{ content: '用户喜欢中文', category: 'preference' }],
  }, mockDeps);
  const parsed = JSON.parse(result);
  expect(parsed[0].status).toBe('saved');
  expect(mockQdrant.upsertVectors).toHaveBeenCalledTimes(1);
  const upsertCall = mockQdrant.upsertVectors.mock.calls[0][0][0];
  expect(upsertCall.payload.source).toBe('chat');
  expect(upsertCall.id).toBe(expect.any(Number));
});
```

Also add necessary mocks at top of file (next to existing mocks):

```typescript
import { insertChatMemory, updateChatMemory } from '../../../src/dao/d1';
vi.mock('../../../src/dao/d1', () => ({
  ...existingMocks,
  insertChatMemory: vi.fn().mockResolvedValue({ id: 100, content: '用户喜欢中文', source: 'chat', user_id: 1, doc_id: null, expires_at: 'some-date' }),
  updateChatMemory: vi.fn().mockResolvedValue(true),
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent/tools.test.ts`
Expected: FAIL — `memory_save` handler not found or returns error

- [ ] **Step 3: Add `memory_save` tool definition to `getToolDefinitions`**

Add to the returned array in `src/agent/tools.ts` `getToolDefinitions()` (after `chunks_search`, before `spawn_agent`):

```typescript
{
  type: 'function',
  function: {
    name: 'memory_save',
    description: 'Save important user information to long-term memory. Use when user shares preferences, facts, or plans worth remembering for future conversations.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Complete, pronoun-free sentence with full context' },
              category: { type: 'string', enum: ['preference', 'fact', 'plan'], description: 'Category: preference (habits/style), fact (identity/info), plan (intentions/schedule)' },
            },
            required: ['content', 'category'],
          },
          minItems: 1,
          maxItems: 5,
          description: 'Memory items to save (1-5 items)',
        },
      },
      required: ['items'],
    },
  },
},
```

- [ ] **Step 4: Implement `do_memory_save` handler**

Add to `src/agent/tools.ts`:

```typescript
import { createTask, listTasks, updateTask, deleteTask, listDocuments, deleteDocument, getChunkIdsByDoc, insertChatMemory, updateChatMemory } from '../dao/d1';

function getExpiresAt(category: string): string | null {
  const fmt = (ms: number) => {
    const d = new Date(Date.now() + ms + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  };
  if (category === 'fact') return null;
  if (category === 'preference') return fmt(180 * 86400 * 1000);
  return fmt(7 * 86400 * 1000);
}

async function do_memory_save(args: any, deps: ToolDeps): Promise<string> {
  const items: { content: string; category: string }[] = args.items;
  if (!items || items.length === 0) return JSON.stringify({ error: 'No items to save' });

  const saved = [];
  for (const item of items) {
    try {
      const [vec] = await deps.embedding.embed([item.content]);

      const existing = await deps.qdrant.searchVectors(vec, deps.userId, 3);
      const duplicate = existing.find((r: any) => r.payload.source === 'chat' && r.score > 0.95);

      const expiresAt = getExpiresAt(item.category);

      if (duplicate) {
        const existingId = duplicate.payload.chunk_id as number;
        await updateChatMemory(deps.d1, existingId, { content: item.content, category: item.category });
        await deps.qdrant.upsertVectors([{
          id: existingId,
          vector: vec,
          payload: { chunk_id: existingId, user_id: deps.userId, source: 'chat', content: item.content, category: item.category, expires_at: expiresAt },
        }]);
        saved.push({ content: item.content, status: 'updated' });
        continue;
      }

      const chunk = await insertChatMemory(deps.d1, {
        userId: deps.userId,
        content: item.content,
        category: item.category,
      });

      await deps.qdrant.upsertVectors([{
        id: chunk!.id,
        vector: vec,
        payload: { chunk_id: chunk!.id, user_id: deps.userId, source: 'chat', content: item.content, category: item.category, expires_at: expiresAt },
      }]);
      saved.push({ content: item.content, status: 'saved' });
    } catch (err: any) {
      saved.push({ content: item.content, status: 'error', error: err.message ?? String(err) });
    }
  }

  log.info('agent:memory_save', 'saved memories', { count: saved.length, statuses: saved.map(s => s.status) });
  return JSON.stringify(saved);
}
```

Add `memory_save: do_memory_save` to the `handlers` map.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent/tools.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools.ts tests/unit/agent/tools.test.ts
git commit -m "feat(agent): add memory_save tool with dedup and expiration"
```

---

## Chunk 3: Prompt + Integration

### Task 5: Add memory management guidance to system prompt

**Files:**
- Modify: `src/agent/prompt.ts`

- [ ] **Step 1: Add memory section to system prompt**

In `src/agent/prompt.ts`, add to the `基本指令` section (after `## 深度研究`):

```
## 记忆管理

你有一个 `memory_save` 工具可以保存重要信息到长期记忆。以下情况应该调用：
- 用户告诉你他的偏好、习惯、身份信息
- 用户做出了重要决策或表达了意图
- 你了解到关于用户的重要事实

以下情况不要调用：
- 通用知识、闲聊、临时指令
- 已经在记忆中存在的信息

每次只保存真正有价值的新信息，宁缺毋滥。
保存时使用完整的、无代词的句子，确保脱离上下文也能理解。
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/agent/prompt.ts
git commit -m "feat(prompt): add memory management guidance for memory_save"
```

---

### Task 6: Update `getSubAgentToolDefinitions` to include memory_save

**Files:**
- Modify: `src/agent/tools.ts`

- [ ] **Step 1: Verify sub-agents can use memory_save**

Check `getSubAgentToolDefinitions` — it only filters out `spawn_agent`. `memory_save` will be available to sub-agents by default. Verify this is correct (yes — sub-agents should be able to save memories).

No code change needed for this task.

---

### Task 7: End-to-end verification

**Files:** None (manual testing)

- [ ] **Step 1: Rebuild local D1**

```bash
pkill -f "wrangler dev"
rm -rf .wrangler/state/v3/d1
npx wrangler d1 execute xvc-agent2 --local --file=schema.sql
npx wrangler d1 execute xvc-agent2 --local --command="INSERT INTO users (email, name) VALUES ('test@test.com', 'Test User'); INSERT INTO threads (user_id, title) VALUES (1, 'Memory Test');"
```

- [ ] **Step 2: Start dev server**

```bash
npx wrangler dev --port 8787
```

- [ ] **Step 3: Test memory_save via chat**

```bash
curl -s -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"threadId":1,"content":"我叫小明，以后叫我小明就行"}'
```

Verify: Agent should call `memory_save` tool with content about user's name preference.

- [ ] **Step 4: Verify memory persisted in D1**

```bash
npx wrangler d1 execute xvc-agent2 --local --command="SELECT id, source, content, expires_at FROM chunks WHERE source='chat'"
```

Expected: 1+ rows with source='chat', content about 小明.

- [ ] **Step 5: Verify memory in Qdrant**

```bash
curl -s -X POST "http://localhost:6333/collections/xvc_agent_chunks/points/scroll" \
  -H "Content-Type: application/json" \
  -H "api-key: local-no-key-needed" \
  -d '{"limit":10,"with_payload":true}' | python3 -m json.tool
```

Expected: Points with `source: 'chat'` in payload.

- [ ] **Step 6: Test recall in new conversation**

Start a new thread and ask something that triggers memory recall:

```bash
curl -s -X POST http://localhost:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 1" \
  -d '{"threadId":1,"content":"你还记得我叫什么名字吗？"}'
```

Expected: Agent should recall "小明" from memory.

---

### Task 8: Update docs

**Files:**
- Modify: `docs/01.memory.md`
- Modify: `docs/03.requirements-tracking.md`

- [ ] **Step 1: Update memory.md**

Update implementation status and source code sections to reflect memory_save.

- [ ] **Step 2: Update requirements tracking**

Change `2.5.3 向量数据库存储对话记忆` from ❌ to ✅.
Add progress log entry.

- [ ] **Step 3: Commit**

```bash
git add docs/01.memory.md docs/03.requirements-tracking.md
git commit -m "docs: update memory.md and tracking for memory_save feature"
```
