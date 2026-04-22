# RAG Confidence Web Search Gating Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use RAG vector similarity score to conditionally guide whether the Agent should perform web search.

**Architecture:** Extend `ChunkResult` with `vectorScore` from Qdrant, refactor `doRagRetrieval` to return structured result, compute tri-state confidence in `execute()`, inject conditional prompt guidance in `buildSystemPrompt`. All changes across 4 source files + 3 test files.

**Tech Stack:** TypeScript, Vitest, existing Qdrant/FTS5 hybrid search

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config.ts` | Modify | Add `ragConfidenceThreshold` to search config |
| `src/services/search.ts` | Modify | Add `vectorScore` to `ChunkResult`/`ChunkWithVector`, propagate through hybrid/vector paths, fix `mmrRerank` return |
| `src/agent/loop.ts` | Modify | `doRagRetrieval` returns `{ context, topVectorScore }`, compute tri-state confidence in `execute()` |
| `src/agent/prompt.ts` | Modify | `buildSystemPrompt` accepts `ragConfidence` param, injects conditional guidance |
| `tests/unit/services/search.test.ts` | Modify | Test `vectorScore` propagation in all modes |
| `tests/unit/agent/loop.test.ts` | Modify | Test `doRagRetrieval` structured return and confidence computation |
| `tests/unit/agent/prompt.test.ts` | Modify | Test tri-state prompt guidance |

---

## Chunk 1: Data Layer

### Task 1: Add config threshold

**Files:**
- Modify: `src/config.ts:22-28`

- [ ] **Step 1: Add `ragConfidenceThreshold` to config**

In `src/config.ts`, add to the `search` object:

```typescript
search: {
    rrfK: 60,
    mmrLambda: 0.7,
    mmrTopK: 5,
    ftsLimit: 20,
    vectorLimit: 20,
    ragConfidenceThreshold: 0.8,
},
```

- [ ] **Step 2: Commit**

```bash
git add src/config.ts
git commit -m "feat: add ragConfidenceThreshold config"
```

---

### Task 2: Extend ChunkResult with vectorScore + fix mmrRerank

**Files:**
- Modify: `src/services/search.ts:35-36,91-96,154-164,189-195,214-222`
- Modify: `tests/unit/services/search.test.ts`

- [ ] **Step 1: Write failing tests for vectorScore propagation**

Add to `tests/unit/services/search.test.ts`, in the `chunksSearch` describe block (after the existing `it('falls back to keyword-only when Qdrant fails'` test):

```typescript
it('in keyword mode has vectorScore undefined', async () => {
    const deps = makeDeps();
    const result = await chunksSearch('test query', 1, 'keyword', deps);
    for (const r of result) {
        expect(r.vectorScore).toBeUndefined();
    }
});

it('in vector mode populates vectorScore from Qdrant', async () => {
    const deps = makeDeps();
    const result = await chunksSearch('test query', 1, 'vector', deps);
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
        expect(r.vectorScore).toBeTypeOf('number');
    }
    expect(result[0].vectorScore).toBe(0.9);
});

it('in hybrid mode propagates vectorScore through mmrRerank', async () => {
    const deps = makeDeps();
    const result = await chunksSearch('test query', 1, 'hybrid', deps);
    const withVecScore = result.filter(r => r.vectorScore !== undefined);
    expect(withVecScore.length).toBeGreaterThan(0);
    const vecScored = result.find(r => r.id === 2);
    expect(vecScored?.vectorScore).toBe(0.9);
});

it('in hybrid mode falls back to FTS-only with vectorScore undefined', async () => {
    const deps = makeDeps();
    deps.qdrant.searchVectors.mockResolvedValue([]);
    const result = await chunksSearch('test query', 1, 'hybrid', deps);
    for (const r of result) {
        expect(r.vectorScore).toBeUndefined();
    }
});
```

Also add a test for `mmrRerank` preserving `vectorScore` in the `mmrRerank` describe block:

```typescript
it('preserves vectorScore in output', () => {
    const queryVec = [1, 0, 0];
    const candidates = [
        { id: 1, content: 'a', score: 1, doc_id: 0, vector: [1, 0, 0], vectorScore: 0.95 },
        { id: 2, content: 'b', score: 0.8, doc_id: 0, vector: [0, 1, 0], vectorScore: 0.7 },
    ];
    const result = mmrRerank(candidates, queryVec, 0.7, 2);
    expect(result).toHaveLength(2);
    const byId = new Map(result.map(r => [r.id, r]));
    expect(byId.get(1)?.vectorScore).toBe(0.95);
    expect(byId.get(2)?.vectorScore).toBe(0.7);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/services/search.test.ts`
Expected: FAIL — `vectorScore` does not exist on `ChunkResult`, `mmrRerank` does not propagate it.

- [ ] **Step 3: Add `vectorScore` to types and propagate through all paths**

In `src/services/search.ts`:

1. Update `ChunkResult` type (line 35):

```typescript
type ChunkResult = { id: number; content: string; score: number; doc_id: number; vectorScore?: number };
```

2. Update `ChunkWithVector` type (line 36):

```typescript
type ChunkWithVector = ChunkResult & { vector?: number[] };
```

3. Fix `mmrRerank` return mapping (lines 91-96) to include `vectorScore`:

```typescript
return selected.map((idx) => ({
    id: candidates[idx].id,
    content: candidates[idx].content,
    score: candidates[idx].score,
    doc_id: candidates[idx].doc_id,
    vectorScore: candidates[idx].vectorScore,
}));
```

4. In hybrid mode `candidates` construction (lines 154-164), add `vectorScore`:

```typescript
const candidates: ChunkWithVector[] = fused.map((item) => {
    const ftsHit = ftsMap.get(item.id as number);
    const vecHit = vecMap.get(item.id as number);
    return {
        id: item.id as number,
        content: ftsHit?.content ?? vecHit?.content ?? '',
        score: item.score,
        doc_id: ftsHit?.doc_id ?? vecHit?.doc_id ?? 0,
        vector: vecHit?.vector,
        vectorScore: vecHit?.vectorScore,
    };
});
```

5. In `vectorSearch` function (lines 189-195), add `vectorScore`:

```typescript
return results.map((r) => ({
    id: r.payload.chunk_id as number,
    content: (r.payload.content as string) ?? '',
    score: r.score,
    doc_id: (r.payload.doc_id as number) ?? 0,
    vectorScore: r.score,
}));
```

6. In `vectorSearchWithVectors` function (lines 214-222), add `vectorScore`:

```typescript
results: results.map((r) => ({
    id: r.payload.chunk_id as number,
    content: (r.payload.content as string) ?? '',
    score: r.score,
    doc_id: (r.payload.doc_id as number) ?? 0,
    vector: r.vector as number[] | undefined,
    vectorScore: r.score,
})),
```

7. In `keywordSearch` (line 177), no change needed — `vectorScore` will be undefined by default.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/services/search.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/search.ts tests/unit/services/search.test.ts
git commit -m "feat: add vectorScore to ChunkResult, propagate through hybrid/vector search and mmrRerank"
```

---

## Chunk 2: Decision Layer

### Task 3: Refactor doRagRetrieval to return structured result

**Files:**
- Modify: `src/agent/loop.ts:113-118,269-286`
- Modify: `tests/unit/agent/loop.test.ts`

- [ ] **Step 1: Write failing test for structured doRagRetrieval return**

Add to `tests/unit/agent/loop.test.ts`, inside the `describe('AgentLoop')` block, after the `'performs RAG pre-retrieval before first LLM call'` test:

```typescript
it('computes ragConfidence from top vectorScore', async () => {
    (chunksSearch as any).mockResolvedValue([
        { id: 1, content: 'doc content', score: 0.05, doc_id: 10, vectorScore: 0.92 },
        { id: 2, content: 'other doc', score: 0.03, doc_id: 11, vectorScore: 0.75 },
    ]);
    const llm = makeMockLLM([[{ type: 'text', content: 'ok' }]]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    await collectEvents(stream);

    expect(buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        ragContext: 'doc content\n---\nother doc',
        ragConfidence: 'high',
    }));
});

it('sets ragConfidence to low when top vectorScore below threshold', async () => {
    (chunksSearch as any).mockResolvedValue([
        { id: 1, content: 'weak match', score: 0.03, doc_id: 10, vectorScore: 0.45 },
    ]);
    const llm = makeMockLLM([[{ type: 'text', content: 'ok' }]]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    await collectEvents(stream);

    expect(buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        ragConfidence: 'low',
    }));
});

it('sets ragConfidence to none when no RAG results', async () => {
    (chunksSearch as any).mockResolvedValue([]);
    const llm = makeMockLLM([[{ type: 'text', content: 'ok' }]]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    await collectEvents(stream);

    expect(buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        ragConfidence: 'none',
    }));
});

it('sets ragConfidence to none when RAG results have no vectorScore', async () => {
    (chunksSearch as any).mockResolvedValue([
        { id: 1, content: 'fts only', score: -1.5, doc_id: 10 },
    ]);
    const llm = makeMockLLM([[{ type: 'text', content: 'ok' }]]);
    deps = makeDeps(llm);

    const stream = new AgentLoop(deps).run(USER_ID, CONV_ID, USER_MSG);
    await collectEvents(stream);

    expect(buildSystemPrompt).toHaveBeenCalledWith(expect.objectContaining({
        ragConfidence: 'none',
    }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/agent/loop.test.ts`
Expected: FAIL — `ragConfidence` is not passed to `buildSystemPrompt`.

- [ ] **Step 3: Refactor doRagRetrieval and execute**

In `src/agent/loop.ts`:

1. Replace the `doRagRetrieval` method (lines 269-286):

```typescript
private async doRagRetrieval(query: string, userId: number): Promise<{ context: string; topVectorScore: number }> {
    try {
      const timeout = new Promise<{ context: string; topVectorScore: number }>((resolve) => setTimeout(() => { log.warn(`agent:${this.agentId}`, `RAG retrieval timed out after ${config.agent.ragTimeoutMs / 1000}s`); resolve({ context: '', topVectorScore: 0 }); }, config.agent.ragTimeoutMs));
      const search = chunksSearch(query, userId, 'hybrid', {
        d1: this.deps.d1,
        qdrant: this.deps.qdrant,
        embedding: this.deps.embedding,
      }).then((results) => {
        log.info(`agent:${this.agentId}`, 'RAG search results', { count: results.length });
        if (results.length === 0) return { context: '', topVectorScore: 0 };
        const topVectorScore = results[0]?.vectorScore ?? 0;
        const context = results.map((r) => r.content).join('\n---\n');
        return { context, topVectorScore };
      });
      return await Promise.race([search, timeout]);
    } catch (err: any) {
      log.warn(`agent:${this.agentId}`, 'RAG retrieval failed', { error: err.message });
      return { context: '', topVectorScore: 0 };
    }
  }
```

2. Update the `execute` method — replace lines 113-125:

```typescript
let ragContext = '';
let ragConfidence: 'high' | 'low' | 'none' = 'none';
if (!options?.skipRag) {
    yield { type: 'status', content: '正在检索相关文档...' };
    const ragResult = await this.doRagRetrieval(userMessage, userId);
    ragContext = ragResult.context;
    const hasRag = ragContext.length > 0;
    ragConfidence = hasRag
        ? (ragResult.topVectorScore >= config.search.ragConfidenceThreshold ? 'high' : 'low')
        : 'none';
    log.info(`agent:${this.agentId}`, 'RAG retrieval done', { contextLen: ragContext.length, topVectorScore: ragResult.topVectorScore, ragConfidence });
}

const user = await getUser(deps.d1, userId);
const userName = user?.name ?? 'User';
const aiNickname = user?.ai_nickname ?? undefined;
const datetime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const tools = options?.tools ?? getToolDefinitions();
const systemPrompt = buildSystemPrompt({ tools, userName, aiNickname, ragContext, ragConfidence, datetime, systemPromptExtra: options?.systemPromptExtra });
log.info(`agent:${this.agentId}`, 'system prompt built', { promptLen: systemPrompt.length, userName, toolCount: tools.length });
```

3. Add `config` import if not already present (it is — line 10).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/agent/loop.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop.ts tests/unit/agent/loop.test.ts
git commit -m "feat: doRagRetrieval returns structured result with topVectorScore, compute tri-state ragConfidence"
```

---

## Chunk 3: Prompt Layer

### Task 4: Add conditional web search guidance to buildSystemPrompt

**Files:**
- Modify: `src/agent/prompt.ts:3-10,89-93`
- Modify: `tests/unit/agent/prompt.test.ts`

- [ ] **Step 1: Write failing tests for tri-state ragConfidence prompt**

Add to `tests/unit/agent/prompt.test.ts`:

```typescript
describe('ragConfidence guidance', () => {
    it('injects high-confidence guidance when ragConfidence is high', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'doc content here',
            ragConfidence: 'high',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).toContain('已从文档中检索到高质量匹配结果');
        expect(result).toContain('无需使用 web_search');
        expect(result).not.toContain('建议使用 web_search 补充');
    });

    it('injects low-confidence guidance when ragConfidence is low', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'weak doc content',
            ragConfidence: 'low',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).toContain('文档匹配度较低');
        expect(result).toContain('建议使用 web_search 补充');
        expect(result).not.toContain('无需使用 web_search');
    });

    it('omits guidance when ragConfidence is none', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: '',
            ragConfidence: 'none',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).not.toContain('已从文档中检索到高质量匹配结果');
        expect(result).not.toContain('建议使用 web_search 补充');
    });

    it('omits guidance when ragConfidence is undefined', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'some content',
            datetime: '2025-04-17 14:30:00 CST',
        });

        expect(result).not.toContain('已从文档中检索到高质量匹配结果');
        expect(result).not.toContain('建议使用 web_search 补充');
    });

    it('places guidance after RAG section and before systemPromptExtra', () => {
        const result = buildSystemPrompt({
            tools: sampleTools,
            userName: 'Alice',
            ragContext: 'doc content',
            ragConfidence: 'high',
            datetime: '2025-04-17 14:30:00 CST',
            systemPromptExtra: '## Extra section',
        });

        const ragIdx = result.indexOf('相关文档');
        const guidanceIdx = result.indexOf('已从文档中检索到高质量匹配结果');
        const extraIdx = result.indexOf('Extra section');

        expect(guidanceIdx).toBeGreaterThan(ragIdx);
        expect(extraIdx).toBeGreaterThan(guidanceIdx);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/agent/prompt.test.ts`
Expected: FAIL — `ragConfidence` not in params, guidance strings not present.

- [ ] **Step 3: Implement conditional guidance in buildSystemPrompt**

In `src/agent/prompt.ts`:

1. Update the `buildSystemPrompt` params type (line 3-10) to add `ragConfidence`:

```typescript
export function buildSystemPrompt(params: {
  tools: ToolDef[];
  userName: string;
  aiNickname?: string;
  ragContext?: string;
  ragConfidence?: 'high' | 'low' | 'none';
  datetime: string;
  systemPromptExtra?: string;
}): string {
```

2. After the RAG context section (after line 93 `}`) and before the `systemPromptExtra` section (line 95), add:

```typescript
if (params.ragConfidence === 'high') {
    sections.push('已从文档中检索到高质量匹配结果，请优先基于上述文档内容回答，无需使用 web_search。');
} else if (params.ragConfidence === 'low') {
    sections.push('文档匹配度较低，如需更准确的信息，建议使用 web_search 补充。');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/agent/prompt.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/prompt.ts tests/unit/agent/prompt.test.ts
git commit -m "feat: add ragConfidence-driven web search guidance to system prompt"
```

---

## Chunk 4: Final Verification

### Task 5: Full suite + lint

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Verify no regressions in existing integration paths**

Run: `npx vitest run tests/unit/agent/loop.test.ts tests/unit/agent/prompt.test.ts tests/unit/services/search.test.ts`
Expected: All tests PASS, including pre-existing tests.
