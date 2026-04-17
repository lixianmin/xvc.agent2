import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingClient } from '../../../src/llm/embedding';

describe('EmbeddingClient', () => {
  let client: EmbeddingClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    client = new EmbeddingClient({ apiKey: 'test-key', baseUrl: 'https://api.example.com', model: 'embedding-3' });
  });

  it('embeds texts and returns vectors', async () => {
    const fakeVector = new Array(1024).fill(0.1);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: fakeVector }, { embedding: fakeVector }] })
    });
    const result = await client.embed(['hello', 'world']);
    expect(result.length).toBe(2);
    expect(result[0].length).toBe(1024);
  });

  it('sends correct request format', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] })
    });
    await client.embed(['test']);
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe('https://api.example.com/v1/embeddings');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('embedding-3');
    expect(body.input).toEqual(['test']);
  });

  it('handles API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Error' });
    await expect(client.embed(['test'])).rejects.toThrow();
  });
});
