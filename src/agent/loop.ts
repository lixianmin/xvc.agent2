import { LLMClient, type Message, type ToolCall } from '../llm/client';
import { EmbeddingClient } from '../llm/embedding';
import { QdrantDAO } from '../dao/qdrant';
import { saveMessage, loadMessages, getUser } from '../dao/d1';
import { buildSystemPrompt } from './prompt';
import { getToolDefinitions, dispatchTool, type ToolDeps } from './tools';
import { chunksSearch } from '../services/search';
import { log } from '../services/logger';

export type AgentDeps = {
  d1: D1Database;
  llm: LLMClient;
  embedding: EmbeddingClient;
  qdrant: QdrantDAO;
  serperApiKey: string;
};

const MAX_ROUNDS = 30;

function sseSend(controller: ReadableStreamDefaultController, event: Record<string, unknown>) {
  log.debug('sse', 'send', event);
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
}

export class AgentLoop {
  constructor(private deps: AgentDeps) {}

  run(userId: number, conversationId: number, userMessage: string): ReadableStream {
    const self = this;

    return new ReadableStream({
      async start(controller) {
        log.info('agent', 'user message received', { userId, conversationId, content: userMessage.slice(0, 200) });
        try {
          await self.executeLoop(controller, userId, conversationId, userMessage);
        } catch (err: any) {
          log.error('agent', 'loop error', { error: err.message, stack: err.stack });
          try {
            sseSend(controller, { type: 'error', content: `处理出错: ${err.message}` });
          } catch { /* controller already closed */ }
        } finally {
          try {
            log.debug('sse', 'send [DONE]');
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          } catch { /* already closed */ }
          log.info('agent', 'loop finished');
        }
      },
    });
  }

  private async executeLoop(
    controller: ReadableStreamDefaultController,
    userId: number,
    conversationId: number,
    userMessage: string,
  ): Promise<void> {
    const { deps } = this;

    sseSend(controller, { type: 'status', content: '正在检索相关文档...' });
    const ragContext = await this.doRagRetrieval(userMessage, userId);
    log.info('agent', 'RAG retrieval done', { contextLen: ragContext.length });

    const user = await getUser(deps.d1, userId);
    const userName = user?.name ?? 'User';
    const aiNickname = user?.ai_nickname ?? undefined;
    const datetime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const tools = getToolDefinitions();
    const systemPrompt = buildSystemPrompt({ tools, userName, aiNickname, ragContext, datetime });
    log.info('agent', 'system prompt built', { promptLen: systemPrompt.length, userName, toolCount: tools.length });

    await saveMessage(deps.d1, {
      conversation_id: conversationId,
      role: 'user',
      content: userMessage,
    });

    const history = await loadMessages(deps.d1, conversationId);
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
    ];
    log.info('agent', 'message history loaded', { historyCount: history.length, totalMsgCount: messages.length });

    for (let round = 0; round < MAX_ROUNDS; round++) {
      sseSend(controller, { type: 'status', content: '正在思考...' });
      log.info('agent', `round ${round + 1} started`);

      const { textContent, toolCalls } = await this.callLLM(messages, tools, controller);
      log.info('agent', `round ${round + 1} LLM done`, { textLen: textContent.length, toolCallCount: toolCalls.length });

      const assistantMsg = await this.saveAssistantMessage(
        conversationId, textContent, toolCalls,
      );
      messages.push(this.toLLMMessage(assistantMsg));

      if (toolCalls.length === 0) {
        log.info('agent', 'loop ended: no tool_calls, final text', { text: textContent.slice(0, 300) });
        break;
      }

      if (round >= MAX_ROUNDS - 1) {
        sseSend(controller, { type: 'limit_reached', content: '已达到最大轮次限制' });
        log.warn('agent', 'max rounds reached');
        break;
      }

      await this.dispatchToolCalls(
        conversationId, userId, toolCalls, messages, controller,
      );
    }
  }

  private async doRagRetrieval(query: string, userId: number): Promise<string> {
    try {
      const timeout = new Promise<string>((resolve) => setTimeout(() => { log.warn('agent', 'RAG retrieval timed out after 5s'); resolve(''); }, 5000));
      const search = chunksSearch(query, userId, 'hybrid', {
        d1: this.deps.d1,
        qdrant: this.deps.qdrant,
        embedding: this.deps.embedding,
      }).then((results) => {
        log.info('agent', 'RAG search results', { count: results.length });
        if (results.length === 0) return '';
        return results.map((r) => r.content).join('\n---\n');
      });
      return await Promise.race([search, timeout]);
    } catch (err: any) {
      log.warn('agent', 'RAG retrieval failed', { error: err.message });
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

    for await (const event of this.deps.llm.chat(messages, tools)) {
      if (event.type === 'text') {
        sseSend(controller, { type: 'text', content: event.content });
        textParts.push(event.content);
      } else if (event.type === 'tool_call') {
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

    return { textContent: textParts.join(''), toolCalls };
  }

  private async saveAssistantMessage(
    conversationId: number,
    content: string,
    toolCalls: ToolCall[],
  ) {
    const saved = await saveMessage(this.deps.d1, {
      conversation_id: conversationId,
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
    conversationId: number,
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

      log.info('agent', 'dispatching tool', { name: tc.function.name, callId: tc.id, args });
      const result = await dispatchTool(tc.function.name, args, toolDeps);
      log.info('agent', 'tool result', { name: tc.function.name, result: result.slice(0, 500) });

      sseSend(controller, {
        type: 'tool_result',
        name: tc.function.name,
        call_id: tc.id,
        result,
      });

      await saveMessage(this.deps.d1, {
        conversation_id: conversationId,
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
