import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMClient, type ChatEvent } from '../../../src/llm/client';

function mockSSEResponse(chunks: object[]) {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
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
    expect(events.some(e => e.type === 'tool_call')).toBe(true);
  });

  it('handles API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Error' });
    await expect(async () => {
      for await (const _ of client.chat([{ role: 'user', content: 'hi' }])) {}
    }).rejects.toThrow();
  });
});
