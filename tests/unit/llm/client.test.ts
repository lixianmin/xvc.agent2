import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, type ChatEvent } from '../../../src/llm/client';

function mockSSEResponse(chunks: object[]) {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function mockStreamingSSEResponse(sseChunks: string[]) {
  let chunkIdx = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (chunkIdx < sseChunks.length) {
        controller.enqueue(new TextEncoder().encode(sseChunks[chunkIdx]));
        chunkIdx++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('LLMClient', () => {
  let client: LLMClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    client = new LLMClient({ apiKey: 'test-key', baseUrl: 'https://api.example.com', model: 'test-model' });
  });

  it('sends messages and yields text events', async () => {
    fetchMock.mockResolvedValueOnce(mockSSEResponse([
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
    ]));
    const events: ChatEvent[] = [];
    for await (const event of client.chat([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events.some(e => e.type === 'text')).toBe(true);
  });

  it('parses tool_calls from response', async () => {
    fetchMock.mockResolvedValueOnce(mockSSEResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"q":"test"}' } }] } }] },
    ]));
    const events: ChatEvent[] = [];
    for await (const event of client.chat([{ role: 'user', content: 'search' }])) {
      events.push(event);
    }

    const tc = events.find(e => e.type === 'tool_call') as Extract<ChatEvent, { type: 'tool_call' }>;
    expect(tc).toBeDefined();
    expect(tc.name).toBe('web_search');
    expect(tc.args).toEqual({ q: 'test' });
  });

  it('handles API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Error' });
    await expect(async () => {
      for await (const _ of client.chat([{ role: 'user', content: 'hi' }])) {}
    }).rejects.toThrow();
  });

  it('yields text events incrementally from streamed chunks', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    fetchMock.mockResolvedValueOnce(mockStreamingSSEResponse(chunks));

    const events: ChatEvent[] = [];
    for await (const event of client.chat([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === 'text');
    expect(textEvents).toHaveLength(3);
    expect(textEvents.map(e => (e as any).content).join('')).toBe('Hello world');
  });

  it('accumulates multi-chunk tool_calls', async () => {
    const chunks = [
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '' } }] } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"test"}' } }] } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }) + '\n\n',
      'data: [DONE]\n\n',
    ];
    fetchMock.mockResolvedValueOnce(mockStreamingSSEResponse(chunks));

    const events: ChatEvent[] = [];
    for await (const event of client.chat([{ role: 'user', content: 'search' }])) {
      events.push(event);
    }

    const tc = events.find(e => e.type === 'tool_call') as Extract<ChatEvent, { type: 'tool_call' }>;
    expect(tc).toBeDefined();
    expect(tc.name).toBe('search');
    expect(tc.args).toEqual({ q: 'test' });
  });
});
