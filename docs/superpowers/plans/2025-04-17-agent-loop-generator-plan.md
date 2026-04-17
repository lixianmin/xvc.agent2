# AgentLoop AsyncGenerator 重构 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AgentLoop 从 SSE 耦合模式重构为 AsyncGenerator 模式，功能不变，为后续 spawn_agent 打基础。

**Architecture:** `execute()` 返回 `AsyncGenerator<AgentEvent>`，核心逻辑不感知输出方式。`run()` 是 SSE 薄包装（含 flush 逻辑），`runSub()` 是内存收集薄包装（Phase 2 实现）。flush 逻辑从 `callLLM` 移到 `run()` SSE 包装层。

**Tech Stack:** TypeScript, AsyncGenerator, Vitest, Cloudflare Workers

**Baseline:** 16 test files, 147 tests passing.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/agent/loop.ts` | **Modify** | AgentLoop 类：构造函数新增 agentId, execute() generator + run() SSE 包装 |
| `src/agent/prompt.ts` | Modify | buildSystemPrompt 新增 systemPromptExtra 参数 |
| `tests/unit/agent/loop.test.ts` | **Modify** | 新增 generator 模式测试 + 验证现有测试兼容 |
| `tests/unit/agent/prompt.test.ts` | Modify | 新增 systemPromptExtra 测试 |
| `src/index.ts` | No change | 调用 `loop.run()` 签名不变 |

---

## Chunk 1: AgentEvent 类型 + 失败测试先行

### Task 1: 定义 AgentEvent 类型

**Files:**
- Modify: `src/agent/loop.ts`（仅添加类型）

- [ ] **Step 1: 在 loop.ts 添加 AgentEvent 类型导出**

在 `AgentDeps` 类型之后添加：

```typescript
export type AgentEvent =
  | { type: 'status'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; call_id: string }
  | { type: 'tool_result'; name: string; call_id: string; result: string }
  | { type: 'error'; content: string }
  | { type: 'limit_reached'; content: string };
```

- [ ] **Step 2: 验证类型编译通过**

Run: `npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/agent/loop.ts
git commit -m "refactor: add AgentEvent type for generator pattern"
```

### Task 2: 写 generator 模式的失败测试

**Files:**
- Modify: `tests/unit/agent/loop.test.ts`

- [ ] **Step 1: 添加 generator 收集工具函数 + import**

在现有 `collectEvents` 函数后添加：

```typescript
async function collectGeneratorEvents(gen: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}
```

更新 import 行，添加 `AgentEvent`：

```typescript
import { AgentLoop, type AgentDeps, type AgentEvent } from '../../../src/agent/loop';
```

- [ ] **Step 2: 写 execute() generator 基础测试**

```typescript
describe('AgentLoop execute() generator', () => {
  let deps: AgentDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    (getUser as any).mockResolvedValue({ id: USER_ID, name: 'TestUser', ai_nickname: '小助' });
    (loadMessages as any).mockResolvedValue([]);
    (saveMessage as any).mockResolvedValue({ id: 1 });
    (chunksSearch as any).mockResolvedValue([]);
  });

  it('execute() yields events as async generator', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'Hello from generator.' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps).execute(USER_ID, CONV_ID, USER_MSG);
    const events = await collectGeneratorEvents(gen);

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents.map(e => e.content).join('')).toContain('Hello from generator.');
    expect(events.some(e => e.type === 'status')).toBe(true);
  });

  it('execute() with persistMessages=false skips all DB writes', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps, 'sub-0').execute(USER_ID, CONV_ID, USER_MSG, {
      persistMessages: false,
    });
    const events = await collectGeneratorEvents(gen);

    expect(saveMessage).not.toHaveBeenCalled();
    expect(loadMessages).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'text')).toBe(true);
  });

  it('execute() with skipRag=true skips RAG retrieval', async () => {
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps, 'sub-0').execute(USER_ID, CONV_ID, USER_MSG, {
      skipRag: true,
    });
    const events = await collectGeneratorEvents(gen);

    expect(chunksSearch).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === 'status' && e.content.includes('检索'))).toHaveLength(0);
  });

  it('execute() with custom tools uses provided tool set', async () => {
    const customTools = [{ type: 'function' as const, function: { name: 'my_tool', description: 'test', parameters: { type: 'object', properties: {} } } }];
    const llm = makeMockLLM([
      [{ type: 'text', content: 'ok' }],
    ]);
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps, 'sub-0').execute(USER_ID, CONV_ID, USER_MSG, {
      tools: customTools,
    });
    await collectGeneratorEvents(gen);

    expect(llm.chat).toHaveBeenCalledWith(
      expect.anything(),
      customTools,
    );
  });

  it('execute() yields limit_reached when max rounds exceeded', async () => {
    const toolEvent: ChatEvent = { type: 'tool_call', name: 'web_search', args: { q: 'x' }, call_id: 'c0' };
    const rounds: ChatEvent[][] = [];
    for (let i = 0; i < 6; i++) {
      rounds.push([toolEvent]);
    }
    const llm = makeMockLLM(rounds);
    (dispatchTool as any).mockResolvedValue('[]');
    deps = makeDeps(llm);

    const gen = new AgentLoop(deps).execute(USER_ID, CONV_ID, USER_MSG, {
      maxRounds: 5,
    });
    const events = await collectGeneratorEvents(gen);

    expect(events.some(e => e.type === 'limit_reached')).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- --run tests/unit/agent/loop.test.ts`
Expected: 新测试失败（`execute is not a function`），原有 8 个测试通过

---

## Chunk 2: 实现 execute() generator

### Task 3: 实现 execute() generator 骨架（status + RAG + prompt）

**Files:**
- Modify: `src/agent/loop.ts`

- [ ] **Step 1: 将 `executeLoop` 改为 `async *execute()` — 骨架部分**

在 `executeLoop` 方法位置，重写为 generator。无 skipRag 分支重复，统一流程：

```typescript
async *execute(
  userId: number,
  threadId: number,
  userMessage: string,
  options?: {
    maxRounds?: number;
    persistMessages?: boolean;
    tools?: ToolDef[];
    systemPromptExtra?: string;
    skipRag?: boolean;
    abortSignal?: AbortSignal;
  },
): AsyncGenerator<AgentEvent> {
  const maxRounds = options?.maxRounds ?? config.agent.maxRounds;
  const persistMessages = options?.persistMessages ?? true;
  const { deps } = this;

  let ragContext = '';
  if (!options?.skipRag) {
    yield { type: 'status', content: '正在检索相关文档...' };
    ragContext = await this.doRagRetrieval(userMessage, userId);
    log.info(`agent:${this.agentId}`, 'RAG retrieval done', { contextLen: ragContext.length });
  }

  const user = await getUser(deps.d1, userId);
  const userName = user?.name ?? 'User';
  const aiNickname = user?.ai_nickname ?? undefined;
  const datetime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const tools = options?.tools ?? getToolDefinitions();
  const systemPrompt = buildSystemPrompt({ tools, userName, aiNickname, ragContext, datetime, systemPromptExtra: options?.systemPromptExtra });
  log.info(`agent:${this.agentId}`, 'system prompt built', { promptLen: systemPrompt.length, userName, toolCount: tools.length });

  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  yield* this.runLoop(userId, threadId, userMessage, tools, messages, maxRounds, persistMessages, options?.abortSignal);
}
```

关键设计：
- `agentId` 在构造函数上（`this.agentId`），不是 execute() 参数
- `messages` 数组在此初始化（只含 system prompt），传给 `runLoop()`
- `runLoop()` 负责追加 user message + history + 每轮的 assistant/tool messages
- `skipRag` 控制是否 yield status + 执行 RAG，避免空 status

- [ ] **Step 2: 实现 runLoop() — 主循环部分**

提取主循环为私有 generator 方法。接收已初始化的 `messages` 数组（含 system prompt），负责追加 history + 每轮消息：

```typescript
private async *runLoop(
  userId: number,
  threadId: number,
  userMessage: string,
  tools: ReturnType<typeof getToolDefinitions>,
  messages: Message[],
  maxRounds: number,
  persistMessages: boolean,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const { deps } = this;
  const agentId = this.agentId;

  if (persistMessages) {
    await saveMessage(deps.d1, { thread_id: threadId, role: 'user', content: userMessage });
    const history = await loadMessages(deps.d1, threadId);
    messages.push(
      ...history.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    );
  }

  log.info(`agent:${agentId}`, 'message history loaded', { totalMsgCount: messages.length });

  for (let round = 0; round < maxRounds; round++) {
    if (abortSignal?.aborted) break;

    yield { type: 'status', content: '正在思考...' };
    log.info(`agent:${agentId}`, `round ${round + 1} started`);

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for await (const event of this.deps.llm.chat(messages, tools)) {
      if (event.type === 'text') {
        yield { type: 'text', content: event.content };
        textParts.push(event.content);
      } else if (event.type === 'tool_call') {
        yield { type: 'tool_call', name: event.name, args: event.args, call_id: event.call_id };
        toolCalls.push({
          id: event.call_id,
          type: 'function',
          function: { name: event.name, arguments: JSON.stringify(event.args) },
        });
      }
    }

    const textContent = textParts.join('');
    log.info(`agent:${agentId}`, `round ${round + 1} LLM done`, { textLen: textContent.length, toolCallCount: toolCalls.length });

    messages.push({
      role: 'assistant',
      content: textContent,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    if (persistMessages) {
      await saveMessage(deps.d1, {
        thread_id: threadId,
        role: 'assistant',
        content: textContent,
        ...(toolCalls.length > 0 ? { tool_calls: JSON.stringify(toolCalls) } : {}),
      });
    }

    if (toolCalls.length === 0) {
      log.info(`agent:${agentId}`, 'loop ended: no tool_calls, final text', { text: textContent.slice(0, 300) });
      break;
    }

    if (round >= maxRounds - 1) {
      yield { type: 'limit_reached', content: '已达到最大轮次限制' };
      log.warn(`agent:${agentId}`, 'max rounds reached');
      break;
    }

    // dispatch tools
    const toolDeps: ToolDeps = {
      d1: deps.d1,
      userId,
      qdrant: deps.qdrant,
      embedding: deps.embedding,
      serperApiKey: deps.serperApiKey,
    };

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }

      log.info(`agent:${agentId}`, 'dispatching tool', { name: tc.function.name, callId: tc.id, args });
      const result = await dispatchTool(tc.function.name, args, toolDeps);
      log.info(`agent:${agentId}`, 'tool result', { name: tc.function.name, result: result.slice(0, 500) });

      yield { type: 'tool_result', name: tc.function.name, call_id: tc.id, result };

      if (persistMessages) {
        await saveMessage(deps.d1, {
          thread_id: threadId,
          role: 'tool',
          content: result,
          tool_call_id: tc.id,
        });
      }

      messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
  }
}
```

- [ ] **Step 3: 重写 `run()` 为 SSE 薄包装**

```typescript
run(userId: number, threadId: number, userMessage: string): ReadableStream {
  const self = this;

  return new ReadableStream({
    async start(controller) {
      const agentId = self.agentId;
      log.info(`agent:${agentId}`, 'user message received', { userId, threadId, content: userMessage.slice(0, 200) });

      let buffer = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const flush = () => {
        if (buffer) {
          sseSend(controller, { type: 'text', content: buffer });
          buffer = '';
        }
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      };

      try {
        for await (const event of self.execute(userId, threadId, userMessage)) {
          if (event.type === 'text') {
            buffer += event.content;
            const shouldFlush = /[。！？.!?\n]/.test(event.content) || buffer.length >= config.agent.textFlushChars;
            if (shouldFlush) {
              flush();
            } else if (!flushTimer) {
              flushTimer = setTimeout(flush, config.agent.textFlushMs);
            }
          } else {
            flush();
            sseSend(controller, event);
          }
        }
        flush();
      } catch (err: any) {
        flush();
        log.error(`agent:${agentId}`, 'loop error', { error: err.message, stack: err.stack });
        try {
          sseSend(controller, { type: 'error', content: `处理出错: ${err.message}` });
        } catch { /* controller already closed */ }
      } finally {
        try {
          log.debug(`agent:${agentId}`, 'send [DONE]');
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        } catch { /* already closed */ }
        log.info(`agent:${agentId}`, 'loop finished');
      }
    },
  });
}
```

- [ ] **Step 4: 验证原有 8 个测试仍通过**

Run: `npm test -- --run tests/unit/agent/loop.test.ts`
Expected: 原有 8 个测试全部通过（`run()` 签名不变，通过 SSE 包装调用 `execute()`）

如果任何测试失败，检查 `run()` 的 flush 逻辑是否正确处理了事件顺序。

- [ ] **Step 5: 删除旧方法**

删除以下方法：
- `private async executeLoop(...)` — 被 `execute()` + `runLoop()` 替代
- `private async callLLM(...)` — 被内联到 `runLoop()`
- `private async saveAssistantMessage(...)` — 被内联到 `runLoop()`
- `private toLLMMessage(...)` — 被内联到 `runLoop()`
- `private async dispatchToolCalls(...)` — 被内联到 `runLoop()`

保留：
- `private async doRagRetrieval(...)` — 仍需要
- `run(...)` — SSE 包装
- `sseSend(...)` — SSE 工具函数
- `async *execute(...)` — 新 generator
- `private async *runLoop(...)` — 新循环方法

- [ ] **Step 6: 运行全部测试**

Run: `npm test -- --run`
Expected: 原有 8 个测试通过（通过 `run()` 调用，签名不变），新增 5 个 generator 测试通过

- [ ] **Step 7: Commit**

```bash
git add src/agent/loop.ts tests/unit/agent/loop.test.ts
git commit -m "refactor: AgentLoop to AsyncGenerator pattern, SSE as thin wrapper"
```

---

## Chunk 3: prompt.ts 扩展 + 全量验证

### Task 4: buildSystemPrompt 新增 systemPromptExtra 参数

**Files:**
- Modify: `src/agent/prompt.ts`
- Modify: `tests/unit/agent/prompt.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/agent/prompt.test.ts` 添加：

```typescript
it('appends systemPromptExtra when provided', () => {
  const result = buildSystemPrompt({
    tools: [],
    userName: 'Test',
    datetime: '2025-04-17',
    systemPromptExtra: '## 子代理模式\n\n你是一个子代理。',
  });
  expect(result).toContain('子代理模式');
  expect(result).toContain('你是一个子代理');
});

it('works without systemPromptExtra', () => {
  const result = buildSystemPrompt({
    tools: [],
    userName: 'Test',
    datetime: '2025-04-17',
  });
  expect(result).toContain('可用工具');
  expect(result).toContain('Test');
});
```

- [ ] **Step 2: 运行测试确认第一个失败**

Run: `npm test -- --run tests/unit/agent/prompt.test.ts`

- [ ] **Step 3: 实现参数**

在 `buildSystemPrompt` 参数类型新增 `systemPromptExtra?: string`。在 sections 构建中（datetime 之前）追加：

```typescript
if (params.systemPromptExtra) {
  sections.push(params.systemPromptExtra);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- --run tests/unit/agent/prompt.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt.ts tests/unit/agent/prompt.test.ts
git commit -m "feat: buildSystemPrompt support systemPromptExtra param"
```

### Task 5: 全量验证 + 文档更新

- [ ] **Step 1: 运行全量测试**

Run: `npm test -- --run`
Expected: 全部通过（原有 147 + 新增 ~7）

- [ ] **Step 2: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 更新 memory.md**

更新 `src/agent/loop.ts` 描述为 AsyncGenerator 模式。

- [ ] **Step 4: Final commit**

```bash
git add docs/01.memory.md
git commit -m "docs: update memory for AsyncGenerator refactor"
```
