# Agent-Initiated Memory Design

## Background

Currently hybrid search only covers uploaded documents (chunks table + Qdrant). Chat history is stored in the messages table but not searchable. Users share important preferences, facts, and plans in conversation that should be retrievable in future sessions.

Post-hoc extraction has a fundamental flaw: resolving pronouns/references requires full conversation history, which causes duplicate extraction. Solution: let the Agent actively save memories as a tool call during conversation.

## Goal

Add a `memory_save` tool that the Agent calls during conversation to persist key information into chunks + Qdrant, making it retrievable via hybrid search in future sessions.

## Design

### 1. New Tool: `memory_save`

The Agent calls this tool during conversation when it judges information is worth remembering. It is a regular tool in the agent loop, same status as `task_create` or `web_search`.

**Tool definition:**
```
name: 'memory_save'
parameters: {
  items: [{
    content: string   // complete, pronoun-free sentence with full context
    category: string  // 'preference' | 'fact' | 'plan'
  }]
}
```

**When the Agent should call it (guided by system prompt):**
- User states preferences, habits, identity information
- User makes important decisions or expresses intentions
- Agent learns important facts about the user

**When NOT to call:**
- General knowledge, small talk, temporary instructions
- Information already in memory

### 2. Why This Solves the Pronoun Problem

The Agent has the full conversation history in its context window when deciding to call `memory_save`. It naturally resolves references like "that project I mentioned" because it can see the earlier messages. The Agent composes the output in its own words, producing complete, pronoun-free sentences.

### 3. Why No Duplicate Extraction

The Agent only calls `memory_save` when it judges new valuable information exists. Casual greetings and general Q&A won't trigger it. This is fundamentally different from post-hoc extraction which processes every conversation.

### 4. Storage

Reuses existing `chunks` table and Qdrant. New columns distinguish chat memories from document chunks.

**Schema change (chunks table):**

D1 (SQLite) does not support `ALTER COLUMN`. Since `doc_id` is currently `NOT NULL`, we must recreate the table with the new columns and relaxed constraint. Migration:

```sql
CREATE TABLE chunks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER REFERENCES documents(id),  -- nullable for chat memories
    user_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'document',   -- 'document' | 'chat'
    expires_at TEXT,                            -- NULL = never expire
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours'))
);
INSERT INTO chunks_new SELECT id, doc_id, user_id, seq, content, 'document', NULL, created_at FROM chunks;
DROP TABLE chunks;
ALTER TABLE chunks_new RENAME TO chunks;

-- Recreate FTS index
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content=chunks, content_rowid=id, tokenize='unicode61');
INSERT INTO chunks_fts(rowid, content) SELECT id, content FROM chunks;
```

| Field | Document chunk | Chat memory |
|-------|---------------|-------------|
| `source` | `document` | `chat` |
| `expires_at` | NULL | Based on category |
| `doc_id` | Links to documents table | NULL |
| `user_id` | Uploader | Current user (via tool deps) |

### 5. Expiration Policy

| category | meaning | expires_at |
|----------|---------|------------|
| `fact` | Personal facts (name, project info, identity) | NULL (never expire) |
| `preference` | User preferences (communication style, naming) | created_at + 180 days |
| `plan` | Plans, intentions, schedules | created_at + 7 days |
| Default (anything else) | - | created_at + 7 days |

### 6. Deduplication

In `do_memory_save`, for each new memory item:
1. Embed the content using EmbeddingClient
2. Search Qdrant for existing chat memories with cosine similarity > 0.95
3. If a highly similar memory exists: **update** its content, category, and expires_at (in both chunks table and Qdrant). This handles users restating preferences in new words.
4. If not: insert new row into chunks + new vector into Qdrant

### 7. Search Adaptation

**FTS (searchFTS in d1.ts):** Add WHERE clause to filter expired chat memories:
```sql
WHERE source = 'document'
   OR (source = 'chat' AND (expires_at IS NULL OR expires_at > datetime('now', '+8 hours')))
```

**Qdrant (searchVectors):** Add `expires_at` and `source` to payload filter.

Note: existing document vectors lack `source`/`expires_at` payloads. The filter must handle both cases — vectors without `source` field (legacy documents) and vectors with `source=chat` (new memories). The `should` clause covers: (1) no source field (legacy documents), (2) source=document, (3) source=chat with no expiration, (4) source=chat with future expiration.
```json
{
  "must": [
    { "key": "user_id", "match": { "value": userId } },
    {
      "should": [
        { "key": "source", "match": { "value": "document" } },
        {
          "must": [
            { "key": "source", "match": { "value": "chat" } },
            { "is_empty": { "key": "expires_at" } }
          ]
        },
        {
          "must": [
            { "key": "source", "match": { "value": "chat" } },
            { "range": { "key": "expires_at", "gt": "<current_datetime>" } }
          ]
        }
      ]
    }
  ]
}
```

### 8. System Prompt Addition

Add a memory management section to the system prompt (via `systemPromptExtra` or direct prompt builder):

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

### 9. Implementation: `do_memory_save`

```typescript
async function do_memory_save(args: any, deps: ToolDeps): Promise<string> {
  const items: { content: string; category: string }[] = args.items;
  if (!items || items.length === 0) return 'No items to save';

  const saved = [];
  for (const item of items) {
    // 1. Embed
    const [vec] = await deps.embedding.embed([item.content]);

    // 2. Check for duplicates
    const existing = await deps.qdrant.searchVectors(vec, deps.userId, 3);
    const isDuplicate = existing.some(r =>
      r.payload.source === 'chat' && r.score > 0.95
    );

    const expiresAt = getExpiresAt(item.category);

    if (isDuplicate) {
      // Update existing memory with new content and refreshed expiration
      const existingId = existing.find(r => r.payload.source === 'chat' && r.score > 0.95)!.payload.chunk_id;
      await updateChatMemory(deps.d1, existingId, { content: item.content, expiresAt });
      await deps.qdrant.upsertVectors([{
        id: String(existingId),
        vector: vec,
        payload: {
          chunk_id: existingId,
          user_id: deps.userId,
          source: 'chat',
          content: item.content,
          category: item.category,
          expires_at: expiresAt,
        },
      }]);
      saved.push({ content: item.content, status: 'updated' });
      continue;
    }

    // 3. Insert into chunks table
    const chunk = await insertChatMemory(deps.d1, {
      userId: deps.userId,
      content: item.content,
      source: 'chat',
      expiresAt,
    });

    // 5. Upsert into Qdrant
    await deps.qdrant.upsertVectors([{
      id: String(chunk.id),
      vector: vec,
      payload: {
        chunk_id: chunk.id,
        user_id: deps.userId,
        source: 'chat',
        content: item.content,
        category: item.category,
        expires_at: expiresAt,
      },
    }]);

    saved.push({ content: item.content, status: 'saved' });
  }

  return JSON.stringify(saved);
}

function getExpiresAt(category: string): string | null {
  const fmt = (ms: number) => {
    const d = new Date(Date.now() + ms + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').replace('Z', '');
  };
  if (category === 'fact') return null;
  if (category === 'preference') return fmt(180 * 86400 * 1000);
  return fmt(7 * 86400 * 1000);  // plan or default: 7 days
}
```

### 10. Data Flow

```
User: "我叫小明，以后叫我小明就行"

Agent Loop:
  LLM thinks → calls memory_save({
    items: [{ content: "用户名叫小明，希望被称呼为小明", category: "preference" }]
  })
  → do_memory_save():
      1. embedding
      2. search Qdrant for similar → no duplicate
      3. insert chunks table (source='chat', expires_at=now+180d)
      4. upsert Qdrant
  → returns "saved" to Agent
  → Agent continues responding to user

Later session:
  User: "帮我创建一个任务"
  → doRagRetrieval → hybrid search hits memory "用户名叫小明"
  → system prompt includes "用户名：小明"
  → Agent addresses user as "小明"
```

## Files

| File | Change |
|------|--------|
| `schema.sql` | Add `source`, `expires_at` columns to chunks |
| `src/dao/d1.ts` | Add `insertChatMemory()`, modify `searchFTS()` to filter expired |
| `src/dao/qdrant.ts` | Add `expires_at` to search filter |
| `src/agent/tools.ts` | Add `memory_save` tool definition + `do_memory_save` + `getExpiresAt` |
| `src/agent/prompt.ts` | Add memory management guidance to system prompt |
| `src/services/search.ts` | Adapt FTS/vector search for source/expiration filtering |
| `tests/unit/agent/tools.test.ts` | Tests for `do_memory_save` and `getExpiresAt` |
| `tests/unit/dao/d1.test.ts` | Tests for `insertChatMemory` |
