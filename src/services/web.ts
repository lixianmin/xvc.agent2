export type SearchResult = {
  title: string;
  link: string;
  snippet: string;
};

const SERPER_URL = 'https://google.serper.dev/search';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_024 * 1024;

export async function serperSearch(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch(SERPER_URL, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, gl: 'cn', hl: 'zh-cn' }),
  });

  if (!res.ok) {
    throw new Error(`Serper API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { organic?: SearchResult[] };
  return (data.organic ?? []).map(({ title, link, snippet }) => ({ title, link, snippet }));
}

export async function fetchUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large: ${contentLength} bytes`);
    }

    const html = await res.text();

    if (html.length > MAX_RESPONSE_BYTES) {
      throw new Error(`Response too large: ${html.length} bytes`);
    }

    return stripHtml(html);
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}
