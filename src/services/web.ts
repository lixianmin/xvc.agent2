export type SearchResult = {
  title: string;
  link: string;
  snippet: string;
};

import { config } from '../config';

const SERPER_URL = 'https://google.serper.dev/search';
const FETCH_TIMEOUT_MS = config.web.fetchTimeoutMs;
const MAX_RESPONSE_BYTES = config.web.maxResponseBytes;

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
  validateUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Redirects are not allowed (status ${res.status})`);
    }

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

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost') {
    throw new Error('URL hostname is blocked: localhost');
  }

  if (hostname.startsWith('[')) {
    const ipv6 = hostname.replace(/^\[|\]$/g, '');
    if (ipv6 === '::1' || ipv6 === '::' || ipv6 === '0:0:0:0:0:0:0:1') {
      throw new Error('URL hostname is blocked: loopback address');
    }
    if (ipv6.startsWith('fc') || ipv6.startsWith('fd') || ipv6.startsWith('fe80:')) {
      throw new Error('URL hostname is blocked: private/local IPv6 address');
    }
    const ipv4Mapped = ipv6.replace(/^::ffff:/, '');
    for (const range of PRIVATE_IP_RANGES) {
      if (range.test(ipv4Mapped)) {
        throw new Error(`URL hostname is blocked: private IP via IPv4-mapped IPv6`);
      }
    }
  }

  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(hostname)) {
      throw new Error(`URL hostname is blocked: private IP ${hostname}`);
    }
  }

  if (/^169\.254\./.test(hostname)) {
    throw new Error(`URL hostname is blocked: link-local IP ${hostname}`);
  }
}
