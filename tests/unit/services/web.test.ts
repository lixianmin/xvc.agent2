import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serperSearch, fetchUrl } from '../../../src/services/web';

describe('serperSearch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  it('calls Serper API correctly and returns results', async () => {
    const organic = [
      { title: 'A', link: 'https://a.com', snippet: 'sa' },
      { title: 'B', link: 'https://b.com', snippet: 'sb' },
    ];
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ organic }),
    });

    const results = await serperSearch('test query', 'my-key');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://google.serper.dev/search');
    expect(init.method).toBe('POST');
    expect(init.headers['X-API-KEY']).toBe('my-key');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ q: 'test query', gl: 'cn', hl: 'zh-cn' });
    expect(results).toEqual(organic);
  });

  it('handles API errors', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
    await expect(serperSearch('q', 'key')).rejects.toThrow();
  });
});

describe('fetchUrl', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  it('fetches URL and extracts text from HTML', async () => {
    const html = '<html><head><title>T</title></head><body><p>Hello world</p></body></html>';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: (n: string) => n === 'content-length' ? String(html.length) : null },
      text: async () => html,
    });

    const text = await fetchUrl('https://example.com');
    expect(text).toContain('Hello world');
    expect(text).not.toContain('<p>');
  });

  it('strips HTML tags', async () => {
    const html = '<div><h1>Title</h1><p>Para <a href="#">link</a></p></div>';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      text: async () => html,
    });

    const text = await fetchUrl('https://example.com');
    expect(text).not.toContain('<');
    expect(text).toContain('Title');
    expect(text).toContain('Para');
    expect(text).toContain('link');
  });

  it('handles network errors', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network fail'));
    await expect(fetchUrl('https://bad.url')).rejects.toThrow('Network fail');
  });
});
