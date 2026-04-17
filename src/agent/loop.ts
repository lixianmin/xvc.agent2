import { LLMClient, type Message, type ToolCall } from '../llm/client';
import { EmbeddingClient } from '../llm/embedding';
import { QdrantDAO } from '../dao/qdrant';
import { saveMessage, loadMessages, getUser } from '../dao/d1';
import { buildSystemPrompt } from './prompt';
import { getToolDefinitions, dispatchTool, type ToolDeps } from './tools';
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

const MAX_ROUNDS = config.agent.maxRounds;

function sseSend(controller: ReadableStreamDefaultController, event: Record<string, unknown>) {
  log.debug('loop:sseSend', 'send', event);
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

export class AgentLoop {
  constructor(private deps: AgentDeps) {}

  run(userId: number, threadId: number, userMessage: string): ReadableStream {
    const self = this;

    return new ReadableStream({
      async start(controller) {
        log.info('loop:run', 'user message received', { userId, threadId, content: userMessage.slice(0, 200) });
        try {
          await self.executeLoop(controller, userId, threadId, userMessage);
        } catch (err: any) {
          log.error('loop:run', 'loop error', { error: err.message, stack: err.stack });
          try {
            sseSend(controller, { type: 'error', content: `处理出错: ${err.message}` });
          } catch { /* controller already closed */ }
        } finally {
          try {
            log.debug('loop:run', 'send [DONE]');
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          } catch { /* already closed */ }
          log.info('loop:run', 'loop finished');
        }
      },
    });
  }

  private async executeLoop(
    controller: ReadableStreamDefaultController,
    userId: number,
    threadId: number,
    userMessage: string,
  ): Promise<void> {
    const { deps } = this;

    sseSend(controller, { type: 'status', content: '正在检索相关文档...' });
    const ragContext = await this.doRagRetrieval(userMessage, userId);
    log.info('loop:executeLoop', 'RAG retrieval done', { contextLen: ragContext.length });

    const user = await getUser(deps.d1, userId);
    const userName = user?.name ?? 'User';
    const aiNickname = user?.ai_nickname ?? undefined;
    const datetime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const tools = getToolDefinitions();
    const systemPrompt = buildSystemPrompt({ tools, userName, aiNickname, ragContext, datetime });
    log.info('loop:executeLoop', 'system prompt built', { promptLen: systemPrompt.length, userName, toolCount: tools.length });

    await saveMessage(deps.d1, {
      thread_id: threadId,
      role: 'user',
      content: userMessage,
    });

    const history = await loadMessages(deps.d1, threadId);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    ];
    log.info('loop:executeLoop', 'message history loaded', { historyCount: history.length, totalMsgCount: messages.length });

    for (let round = 0; round < MAX_ROUNDS; round++) {
      sseSend(controller, { type: 'status', content: '正在思考...' });
      log.info('loop:executeLoop', `round ${round + 1} started`);

      const { textContent, toolCalls } = await this.callLLM(messages, tools, controller);
      log.info('loop:executeLoop', `round ${round + 1} LLM done`, { textLen: textContent.length, toolCallCount: toolCalls.length });

      const assistantMsg = await this.saveAssistantMessage(
        threadId, textContent, toolCalls,
      );
      messages.push(this.toLLMMessage(assistantMsg));

      if (toolCalls.length === 0) {
        log.info('loop:executeLoop', 'loop ended: no tool_calls, final text', { text: textContent.slice(0, 300) });
        break;
      }

      if (round >= MAX_ROUNDS - 1) {
        sseSend(controller, { type: 'limit_reached', content: '已达到最大轮次限制' });
        log.warn('loop:executeLoop', 'max rounds reached');
        break;
      }

      await this.dispatchToolCalls(
        threadId, userId, toolCalls, messages, controller,
      );
    }
  }

  private async doRagRetrieval(query: string, userId: number): Promise<string> {
    try {
      const timeout = new Promise<string>((resolve) => setTimeout(() => { log.warn('loop:doRagRetrieval', `RAG retrieval timed out after ${config.agent.ragTimeoutMs / 1000}s`); resolve(''); }, config.agent.ragTimeoutMs));
      const search = chunksSearch(query, userId, 'hybrid', {
        d1: this.deps.d1,
        qdrant: this.deps.qdrant,
        embedding: this.deps.embedding,
      }).then((results) => {
        log.info('loop:doRagRetrieval', 'RAG search results', { count: results.length });
        if (results.length === 0) return '';
        return results.map((r) => r.content).join('\n---\n');
      });
      return await Promise.race([search, timeout]);
    } catch (err: any) {
      log.warn('loop:doRagRetrieval', 'RAG retrieval failed', { error: err.message });
      return '';
    }
  }

  private async callLLM(
    messages: Message[],
    tools: ReturnType<typeof getToolDefinitions>,
    controller: ReadableStreamDefaultController,
  ): Promise<{ textContent: string; toolCalls: ToolCall[] }> {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (buffer) {
        sseSend(controller, { type: 'text', content: buffer });
        textParts.push(buffer);
        buffer = '';
      }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    };

    for await (const event of this.deps.llm.chat(messages, tools)) {
      if (event.type === 'text') {
        buffer += event.content;
        const shouldFlush = /[。！？.!?\n]/.test(event.content) || buffer.length >= config.agent.textFlushChars;
        if (shouldFlush) {
          flush();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flush, config.agent.textFlushMs);
        }
      } else if (event.type === 'tool_call') {
        flush();
        sseSend(controller, {
          type: 'tool_call',
          name: event.name,
          args: event.args,
          call_id: event.call_id,
        });
        toolCalls.push({
          id: event.call_id,
          type: 'function',
          function: { name: event.name, arguments: JSON.stringify(event.args) },
        });
      }
    }

    flush();
    return { textContent: textParts.join(''), toolCalls };
  }

  private async saveAssistantMessage(
    threadId: number,
    content: string,
    toolCalls: ToolCall[],
  ) {
    const saved = await saveMessage(this.deps.d1, {
      thread_id: threadId,
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: JSON.stringify(toolCalls) } : {}),
    });
    return saved;
  }

  private toLLMMessage(msg: any): Message {
    return {
      role: msg.role,
      content: msg.content,
      ...(msg.tool_calls ? { tool_calls: JSON.parse(msg.tool_calls) } : {}),
      ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
    };
  }

  private async dispatchToolCalls(
    threadId: number,
    userId: number,
    toolCalls: ToolCall[],
    messages: Message[],
    controller: ReadableStreamDefaultController,
  ): Promise<void> {
    const toolDeps: ToolDeps = {
      d1: this.deps.d1,
      userId,
      qdrant: this.deps.qdrant,
      embedding: this.deps.embedding,
      serperApiKey: this.deps.serperApiKey,
    };

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }

      log.info('loop:dispatchToolCalls', 'dispatching tool', { name: tc.function.name, callId: tc.id, args });
      const result = await dispatchTool(tc.function.name, args, toolDeps);
      log.info('loop:dispatchToolCalls', 'tool result', { name: tc.function.name, result: result.slice(0, 500) });

      sseSend(controller, {
        type: 'tool_result',
        name: tc.function.name,
        call_id: tc.id,
        result,
      });

      await saveMessage(this.deps.d1, {
        thread_id: threadId,
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
      });

      messages.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
      });
    }
  }
}
