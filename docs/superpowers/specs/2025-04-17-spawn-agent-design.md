# spawn_agent 工具设计 — AsyncGenerator AgentLoop

## Overview

重构 `AgentLoop` 为 AsyncGenerator 模式，将 SSE 输出从核心 loop 逻辑中解耦。在此基础上添加 `spawn_agent` 工具，支持主代理创建上下文隔离的子代理。

**设计原则**：
- `AgentLoop.execute()` 返回 `AsyncGenerator<AgentEvent>`，核心逻辑不感知输出方式
- SSE 是调用方对 generator 的薄包装，不是 AgentLoop 的职责
- 子代理复用同一个 `execute()`，调用方只收集 text 事件
- 日志留在 generator 内部（所有代码都需要），仅通过 agentId 区分来源
- 不引入新文件、新依赖、新数据库表

---

## 0. AgentEvent 类型

Generator yield 的事件类型，与 SSE 事件格式完全一致：

```typescript
type AgentEvent =
  | { type: 'status'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; call_id: string }
  | { type: 'tool_result'; name: string; call_id: string; result: string }
  | { type: 'error'; content: string }
  | { type: 'limit_reached'; content: string };
```

---

## 1. AgentLoop 重构

### Before（当前）

```
run() → ReadableStream
  └─ executeLoop(controller: ReadableStreamDefaultController)
       ├─ sseSend(controller, { type: 'status', ... })
       ├─ callLLM(messages, tools, controller)  ← controller 贯穿到底
       └─ dispatchToolCalls(threadId, userId, toolCalls, messages, controller)
```

`ReadableStreamDefaultController` 作为参数在 3 个方法间传递，核心逻辑与 SSE 耦合。

### After

```
AgentLoop 构造: new AgentLoop(deps, agentId?)
  └─ execute(userId, threadId, userMessage, options?) → AsyncGenerator<AgentEvent>
       ├─ yield { type: 'status', ... }
       ├─ for await (event of llm.chat(messages, tools)) yield event
       ├─ yield { type: 'tool_result', ... }
       └─ 日志内部处理，不依赖外部

主代理: run() → ReadableStream     ← 薄包装，调用 execute()
子代理: 新 AgentLoop(deps, 'sub-0') → execute() → 收集 text
```

### 构造函数

```typescript
constructor(
  private deps: AgentDeps,
  private readonly agentId: string = 'main',
)
```

`agentId` 是实例属性，不是每次调用时传的。主代理默认 `"main"`，子代理创建新实例时传 `"sub-0"` / `"sub-1"` 等。

### execute() 签名

```typescript
async *execute(
  userId: number,
  threadId: number,
  userMessage: string,
  options?: {
    maxRounds?: number;        // 默认 30
    persistMessages?: boolean; // 默认 true
    tools?: ToolDef[];         // 默认 getToolDefinitions()，子代理传排除 spawn_agent 的子集
    systemPromptExtra?: string; // 子代理专属指令
    skipRag?: boolean;         // 子代理跳过 RAG pre-retrieval
    abortSignal?: AbortSignal; // 子代理超时控制
  }
): AsyncGenerator<AgentEvent>
```

### run() — SSE 薄包装

```typescript
run(userId: number, threadId: number, userMessage: string): ReadableStream {
  const self = this;
  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of self.execute(userId, threadId, userMessage)) {
          sseSend(controller, event);
        }
      } catch (err: any) {
        sseSend(controller, { type: 'error', content: `处理出错: ${err.message}` });
      } finally {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}
```

### runSub() — 子代理薄包装

子代理不调用 `this.execute()`，而是创建**新的 AgentLoop 实例**。这避免了在同一实例上递归调用 generator 的风险，也确保上下文完全隔离：

```typescript
static async runSub(
  deps: AgentDeps,
  agentId: string,
  userId: number,
  task: string,
  context?: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const subLoop = new AgentLoop(deps, agentId);
  try {
    let result = '';
    const userMessage = context ? `背景信息：${context}\n\n任务：${task}` : task;
    for await (const event of subLoop.execute(userId, 0, userMessage, {
      maxRounds: 15,
      persistMessages: false,
      tools: getSubAgentToolDefinitions(),
      systemPromptExtra: SUB_AGENT_PROMPT,
      skipRag: true,
      abortSignal: controller.signal,
    })) {
      if (event.type === 'text') result += event.content;
    }
    return result || '[子代理无输出]';
  } catch (err: any) {
    if (controller.signal.aborted) return '[子代理执行超时]';
    return `[子代理执行失败: ${err.message}]`;
  } finally {
    clearTimeout(timeout);
  }
}
```

### callLLM 中的 flush 逻辑

当前的 buffer + 按标点/大小 flush 是 SSE 专属的 UX 优化。重构后：

- `execute()` 内部 **直接 yield 原始 text chunk**，不做 flush
- flush 逻辑移到 `run()` 的 SSE 包装层（或独立为 `createSseFlusher()` 工具函数）
- `runSub()` 不需要 flush，直接拼接

### dispatchToolCalls 中的 spawn_agent 处理

spawn_agent 不经过 `dispatchTool()`，在 `execute()` 的 tool dispatch 循环中做特殊处理。这是 Phase 2 实现时的具体设计，Phase 1 不涉及。实现时在 `runLoop()` 的 tool dispatch for 循环内加 `if (name === 'spawn_agent')` 分支：

```typescript
for (const tc of toolCalls) {
  if (tc.function.name === 'spawn_agent') {
    yield { type: 'status', content: `已启动 ${tasks.length} 个子代理...` };
    const results = await Promise.allSettled(
      tasks.map((task, i) => AgentLoop.runSub(deps, `sub-${i}`, userId, task, context))
    );
    yield { type: 'status', content: '子代理全部完成，正在整合结果...' };
    result = JSON.stringify(results.map(...));
  } else {
    result = await dispatchTool(tc.function.name, args, toolDeps);
  }
  yield { type: 'tool_result', ... };
}
```

---

## 2. spawn_agent 工具定义

```json
{
  "type": "function",
  "function": {
    "name": "spawn_agent",
    "description": "Spawn 1-3 sub-agents to execute tasks in parallel. Each sub-agent has isolated context and can use search/file tools. Returns results for each task.",
    "parameters": {
      "type": "object",
      "properties": {
        "tasks": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Task descriptions for sub-agents (1-3 tasks)",
          "minItems": 1,
          "maxItems": 3
        },
        "context": {
          "type": "string",
          "description": "Optional shared context to pass to all sub-agents (e.g., background info, constraints)"
        }
      },
      "required": ["tasks"]
    }
  }
}
```

**返回值格式**（tool_result 内容）：

```json
[
  { "task": "搜索 X 的最新进展", "result": "根据搜索结果..." },
  { "task": "查找 Y 的技术文档", "result": "找到以下文档..." }
]
```

### 子代理可用工具

子代理可使用主代理的所有工具，**除去 `spawn_agent`**（防止嵌套）：

| 工具 | 可用 |
|------|------|
| task_create/list/update/delete | 是 |
| web_search / web_fetch | 是 |
| file_list / file_delete | 是 |
| chunks_search | 是 |
| spawn_agent | **否** |

---

## 3. 执行流程

```
主代理 execute() generator:
  if (!skipRag):
    yield status: '正在检索相关文档...'
    RAG retrieval
  build system prompt → load history
  for round 1..N:
    yield status: '正在思考...'
    for await (event of llm.chat(messages, tools)):
      yield { type: 'text' / 'tool_call', ... }
    if no tool_calls → break

    for each tool_call:
      if name === 'spawn_agent':
        yield status: '已启动 N 个子代理...'
        results = Promise.allSettled(runSub for each task)
        yield status: '子代理全部完成，正在整合结果...'
        result = JSON.stringify(results)
      else:
        result = dispatchTool(name, args, deps)
      yield { type: 'tool_result', ... }
```

### 子代理错误处理

使用 `Promise.allSettled`：
- 成功的子代理正常返回 result
- 失败的子代理返回 `"[子代理执行失败: ...]"` 而非导致整体失败
- 主代理 LLM 可根据失败信息决定是否重试或调整策略

### SSE 事件（主代理视角）

```
{ type: "status", content: "正在检索相关文档..." }
{ type: "status", content: "正在思考..." }
{ type: "text", content: "让我帮你研究..." }
{ type: "tool_call", name: "spawn_agent", ... }
{ type: "status", content: "已启动 2 个子代理..." }
{ type: "status", content: "子代理全部完成，正在整合结果..." }
{ type: "tool_result", name: "spawn_agent", ... }
{ type: "text", content: "根据研究结果..." }
```

---

## 4. 子代理 System Prompt

复用 `buildSystemPrompt()`，通过 `systemPromptExtra` 参数注入：

```
## 子代理模式

你是一个子代理，负责完成主代理委派给你的特定任务。
- 直接执行任务，输出结果，不需要寒暄或过渡语
- 任务描述就是你的输入，完成后输出完整的执行结果
- 你可以调用工具（搜索、文件检索等）来完成任务
```

子代理 prompt 的构建参数：
- `tools`：`getSubAgentToolDefinitions()`（排除 spawn_agent）
- `userName`：继承主代理的 userName
- `aiNickname`：不传（子代理不需要昵称）
- `ragContext`：不传（skipRag=true）
- `datetime`：继承当前时间
- `systemPromptExtra`：子代理专属指令

---

## 5. 日志与 AgentId

所有 `AgentLoop` 内部日志使用 `agentId` 前缀：

| 角色 | agentId | 日志示例 |
|------|---------|----------|
| 主代理 | `"main"` | `[agent:main] round 3 LLM done` |
| 子代理 0 | `"sub-0"` | `[agent:sub-0] round 2 tool_call: web_search` |
| 子代理 1 | `"sub-1"` | `[agent:sub-1] round 1 LLM done` |

日志在 `execute()` generator 内部产生，不依赖外部。调用方（run / runSub）不负责日志。

---

## 6. 资源控制

| 参数 | 主代理 | 子代理 | 理由 |
|------|--------|--------|------|
| 最大轮次 | 30 | 15 | 子代理占用主代理的 CPU 时间，需限制 |
| 消息持久化 | 写入 D1 | **不写入** | 子代理是临时执行，结果通过 tool_result 返回 |
| RAG pre-retrieval | 自动执行 | **不执行** | 子代理通过 chunks_search 工具主动搜索 |
| 嵌套 spawn | 允许 | **禁止** | 子代理工具集不含 spawn_agent |
| 子代理超时 | — | 30s wall-clock | AbortController + setTimeout |
| 并行数量上限 | 最多 3 个 | — | CF Worker CPU 时间约束 |

---

## 7. 对现有代码的影响

### AgentLoop (`src/agent/loop.ts`) — 主要改动

- **核心方法 `execute()`**：从 `private async executeLoop(controller, ...)` 改为 `async *execute(userId, threadId, userMessage, options?)` — AsyncGenerator（`agentId` 在构造函数上）
- **移除 SSE 依赖**：所有 `sseSend(controller, ...)` 改为 `yield event`，不再接收 `ReadableStreamDefaultController`
- **`run()`**：改为 `execute()` 的 SSE 薄包装（for await + sseSend）
- **新增 `static runSub()`**：创建新 AgentLoop 实例 + `execute()` 内存收集
- **`callLLM()`**：直接透传 LLM generator 事件（yield 原始 text chunk），flush 逻辑移到 `run()` 的 SSE 包装层
- **`dispatchToolCalls()`**：普通工具走原逻辑，spawn_agent 在 `runLoop()` 的 tool dispatch 循环内特殊处理（Phase 2）
- **构造函数**：新增 `agentId: string`（默认 `"main"`）
- **日志**：所有 `log.*` 调用改用 `[agent:${this.agentId}]` 前缀

### tools.ts (`src/agent/tools.ts`)

- `getToolDefinitions()` 返回值新增 `spawn_agent` 定义
- 新增 `getSubAgentToolDefinitions()`：排除 `spawn_agent`
- spawn_agent 的 handler 逻辑移到 `AgentLoop.execute()` 内（因为需要 yield status 事件），`do_spawn_agent` 作为 `execute()` 内的私有方法

### prompt.ts (`src/agent/prompt.ts`)

- `buildSystemPrompt` 参数新增 `systemPromptExtra?: string`
- 追加到 "基本指令" section 末尾

### index.ts (`src/index.ts`)

- chat route 中调用 `agentLoop.run(...)` 不变（签名未变）

### 不变的部分

- `LLMClient`、`EmbeddingClient`、所有 DAO、所有 services：无需修改
- 数据库 schema：无变更
- 前端：无变更（SSE 事件格式兼容）
- API 路由签名：无变更

---

## 8. 测试策略

### 单元测试

1. **execute() generator**：验证 yield 事件序列正确（status → text/tool_call → tool_result → ...）
2. **run() SSE 包装**：验证 ReadableStream 输出正确 SSE 格式
3. **runSub() 内存收集**：验证只收集 text 事件，忽略 status/tool_call/tool_result
4. **spawn_agent 工具定义**：验证 schema 正确（参数校验、tasks 数组长度限制）
5. **getSubAgentToolDefinitions**：验证排除 spawn_agent，包含其他所有工具
6. **子代理 system prompt**：验证 systemPromptExtra 追加正确
7. **agentId 日志**：验证日志前缀包含正确的 agentId
8. **子代理失败隔离**：mock LLM 抛异常，验证返回可理解的错误信息
9. **子代理超时**：mock LLM 延迟超过 30s，验证返回超时信息

### 集成测试

1. **正常对话**：用户发送消息 → run() → SSE stream 完整输出
2. **单子代理**：用户发送复杂研究问题 → spawn_agent(1 task) → 返回结果
3. **多子代理并行**：spawn_agent(3 tasks) → 3 个子代理并行执行 → 全部返回
4. **工具隔离**：验证子代理的 spawn_agent 调用返回 "Unknown tool" 错误
