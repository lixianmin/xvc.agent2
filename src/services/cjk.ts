type CJKLang = 'zh' | 'ja' | 'ko';

function getCJKLang(cp: number): CJKLang | null {
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  )
    return 'zh';

  if (
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff65 && cp <= 0xff9f) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  )
    return 'ja';

  if (
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  )
    return 'ko';

  return null;
}

const CJK_RE = /[\u3040-\u9fff\uac00-\ud7af]/;

export function containsCJK(text: string): boolean {
  return CJK_RE.test(text);
}

type ScriptChunk = {
  text: string;
  lang: CJKLang;
};

function splitByScript(text: string): ScriptChunk[] {
  const chunks: ScriptChunk[] = [];
  let current = '';
  let currentLang: CJKLang = 'zh';

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const lang = getCJKLang(cp);

    if (/\s/.test(ch)) {
      if (current) {
        chunks.push({ text: current, lang: currentLang });
        current = '';
      }
      continue;
    }

    if (current && lang) {
      if (lang !== currentLang) {
        chunks.push({ text: current, lang: currentLang });
        current = '';
      }
    }

    if (!current && lang) currentLang = lang;

    current += ch;
  }

  if (current) {
    chunks.push({ text: current, lang: currentLang });
  }

  return chunks;
}

const segmenters: Partial<Record<CJKLang, Intl.Segmenter>> = {};

function getSegmenter(lang: CJKLang): Intl.Segmenter {
  if (!segmenters[lang]) segmenters[lang] = new Intl.Segmenter(lang, { granularity: 'word' });
  return segmenters[lang]!;
}

function segmentByIntl(text: string, segmenter: Intl.Segmenter): string {
  return [...segmenter.segment(text)]
    .filter((seg) => seg.isWordLike)
    .map((seg) => seg.segment)
    .join(' ');
}

export function tokenizeCJK(text: string): string {
  if (!containsCJK(text)) return text;

  const chunks = splitByScript(text);
  const tokens: string[] = [];

  for (const chunk of chunks) {
    tokens.push(segmentByIntl(chunk.text, getSegmenter(chunk.lang)));
  }

  return tokens.filter(Boolean).join(' ');
}
