import { LLMClient, type Message, type ToolCall } from '../llm/client';
import { EmbeddingClient } from '../llm/embedding';
import { QdrantDAO } from '../dao/qdrant';
import { saveMessage, loadMessages, getUser } from '../dao/d1';
import { buildSystemPrompt } from './prompt';
import { getToolDefinitions, getSubAgentToolDefinitions, dispatchTool, type ToolDeps } from './tools';
import { chunksSearch } from '../services/search';
import { log } from '../services/logger';
import { config } from '../config';

export type AgentEvent =
  | { type: 'status'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; call_id: string }
  | { type: 'tool_result'; name: string; call_id: string; result: string }
  | { type: 'error'; content: string }
  | { type: 'limit_reached'; content: string };

export type AgentDeps = {
  d1: D1Database;
  llm: LLMClient;
  embedding: EmbeddingClient;
  qdrant: QdrantDAO;
  serperApiKey: string;
};

function sseSend(controller: ReadableStreamDefaultController, event: Record<string, unknown>) {
  log.debug('loop:sseSend', 'send', event);
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

const SUB_AGENT_PROMPT = `## 子代理模式

你是一个子代理，负责完成主代理委派给你的特定任务。
- 直接执行任务，输出结果，不需要寒暄或过渡语
- 任务描述就是你的输入，完成后输出完整的执行结果
- 你可以调用工具（搜索、文件检索等）来完成任务`;

export class AgentLoop {
  constructor(
    private deps: AgentDeps,
    private readonly agentId: string = 'main',
  ) {}

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

  async *execute(
    userId: number,
    threadId: number,
    userMessage: string,
    options?: {
      maxRounds?: number;
      persistMessages?: boolean;
      tools?: ReturnType<typeof getToolDefinitions>;
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
      log.info(`agent:${agentId}`, 'loadMessages returned', { threadId, historyCount: history.length, firstMsgId: history[0]?.id, lastMsgId: history[history.length - 1]?.id });
      messages.push(
        ...history.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
      );
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    log.info(`agent:${agentId}`, 'message history loaded', { threadId, totalMsgCount: messages.length });

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

        let result: string;

        if (tc.function.name === 'spawn_agent') {
          const tasks = (args.tasks as string[]) || [];
          const ctx = args.context as string | undefined;
          yield { type: 'status', content: `已启动 ${tasks.length} 个子代理...` };
          const settled = await Promise.allSettled(
            tasks.map((task, i) => AgentLoop.runSub(deps, `sub-${i}`, userId, task, ctx)),
          );
          yield { type: 'status', content: '子代理全部完成，正在整合结果...' };
          result = JSON.stringify(
            tasks.map((task, i) => ({
              task,
              result: settled[i].status === 'fulfilled' ? settled[i].value : `[子代理执行失败: ${(settled[i] as PromiseRejectedResult).reason}]`,
            })),
          );
          log.info(`agent:${agentId}`, 'spawn_agent result', { taskCount: tasks.length });
        } else {
          log.info(`agent:${agentId}`, 'dispatching tool', { name: tc.function.name, callId: tc.id, args });
          result = await dispatchTool(tc.function.name, args, toolDeps);
          log.info(`agent:${agentId}`, 'tool result', { name: tc.function.name, result: result.slice(0, 500) });
        }

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

  private async doRagRetrieval(query: string, userId: number): Promise<string> {
    try {
      const timeout = new Promise<string>((resolve) => setTimeout(() => { log.warn(`agent:${this.agentId}`, `RAG retrieval timed out after ${config.agent.ragTimeoutMs / 1000}s`); resolve(''); }, config.agent.ragTimeoutMs));
      const search = chunksSearch(query, userId, 'hybrid', {
        d1: this.deps.d1,
        qdrant: this.deps.qdrant,
        embedding: this.deps.embedding,
      }).then((results) => {
        log.info(`agent:${this.agentId}`, 'RAG search results', { count: results.length });
        if (results.length === 0) return '';
        return results.map((r) => r.content).join('\n---\n');
      });
      return await Promise.race([search, timeout]);
    } catch (err: any) {
      log.warn(`agent:${this.agentId}`, 'RAG retrieval failed', { error: err.message });
      return '';
    }
  }
}
