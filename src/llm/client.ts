import { log } from '../services/logger';
import { config } from '../config';
import type { ToolDef } from '../agent/tools';

export type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; call_id: string }
  | { type: 'tool_result'; name: string; call_id: string; result: string };

export class LLMClient {
  constructor(private config: { apiKey: string; baseUrl: string; model: string }) {}

  async *chat(messages: Message[], tools?: ToolDef[]): AsyncGenerator<ChatEvent> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = { model: this.config.model, messages, stream: true };
    if (tools?.length) body.tools = tools;

    log.info('client:chat', 'LLM request', {
      url,
      model: this.config.model,
      msgCount: messages.length,
      toolCount: tools?.length ?? 0,
      messages: messages.map(m => ({ role: m.role, contentLen: m.content?.length ?? 0, hasToolCalls: !!m.tool_calls, hasToolCallId: !!m.tool_call_id })),
    });

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= config.agent.llmMaxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          log.error('client:chat', 'LLM API error', { status: res.status, statusText: res.statusText, errorBody: errorBody.slice(0, 2000), attempt });
          throw new Error(`LLM API error: ${res.status} ${res.statusText}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        const toolAccum = new Map<number, { id: string; name: string; args: string }>();
        let textChunks = 0;
        let toolCallCount = 0;
        let sseBuffer = '';
        let streamDone = false;

        while (!streamDone) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = sseBuffer.indexOf('\n\n')) !== -1) {
            const block = sseBuffer.slice(0, boundary);
            sseBuffer = sseBuffer.slice(boundary + 2);

            const line = block.trim();
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6);
            if (payload === '[DONE]') { streamDone = true; break; }

            let parsed: { choices?: { delta?: { content?: string; tool_calls?: DeltaToolCall[] }; finish_reason?: string | null }[] };
            try { parsed = JSON.parse(payload); } catch { continue; }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            if (choice.delta?.content) {
              textChunks++;
              yield { type: 'text', content: choice.delta.content };
            }

            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index;
                let acc = toolAccum.get(idx);
                if (!acc) {
                  acc = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' };
                  toolAccum.set(idx, acc);
                }
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
              }
            }

            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              for (const [, acc] of toolAccum) {
                let args: Record<string, unknown> = {};
                try { args = JSON.parse(acc.args); } catch { args = { _parseError: `LLM returned invalid JSON for tool arguments: ${acc.args.slice(0, 200)}` }; }
                toolCallCount++;
                yield { type: 'tool_call', name: acc.name, args, call_id: acc.id };
              }
              toolAccum.clear();
            }
          }
        }

        for (const [, acc] of toolAccum) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(acc.args); } catch { args = { _parseError: `LLM returned invalid JSON for tool arguments: ${acc.args.slice(0, 200)}` }; }
          toolCallCount++;
          yield { type: 'tool_call', name: acc.name, args, call_id: acc.id };
        }

        log.info('client:chat', 'LLM response done', { textChunks, toolCallCount });
        return;
      } catch (err: any) {
        lastError = err;
        if (attempt < config.agent.llmMaxRetries) {
          log.warn('client:chat', `LLM call failed, retrying (${attempt + 1}/${config.agent.llmMaxRetries})`, { error: err.message });
          await new Promise(r => setTimeout(r, config.agent.llmRetryDelayMs));
        }
      }
    }
    throw lastError;
  }

  async describeImage(base64DataUrl: string, prompt: string): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    log.info('client:describeImage', 'vision request', { model: this.config.model });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: base64DataUrl } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`Vision API error: ${res.status} ${res.statusText}`);
    const data = await res.json() as { choices: { message: { content: string } }[] };
    log.info('client:describeImage', 'vision response received');
    return data.choices[0].message.content;
  }
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface Message {
  role: string;
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface DeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
