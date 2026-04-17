type Script = 'hangul' | 'han' | 'kana' | 'other';

function getScript(cp: number): Script {
  if (
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3130 && cp <= 0x318f)
  )
    return 'hangul';

  if (
    (cp >= 0x3040 && cp <= 0x309f) ||
    (cp >= 0x30a0 && cp <= 0x30ff) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0xff65 && cp <= 0xff9f)
  )
    return 'kana';

  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  )
    return 'han';

  return 'other';
}

const CJK_RE = /[\u3040-\u9fff\uac00-\ud7af]/;

export function containsCJK(text: string): boolean {
  return CJK_RE.test(text);
}

interface ScriptChunk {
  text: string;
  script: Script;
}

function splitByScript(text: string): ScriptChunk[] {
  const chunks: ScriptChunk[] = [];
  let current = '';
  let currentScript: Script = 'other';

  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const script = getScript(cp);

    if (/\s/.test(ch)) {
      if (current) {
        chunks.push({ text: current, script: currentScript });
        current = '';
        currentScript = 'other';
      }
      continue;
    }

    if (current && script !== currentScript) {
      const shouldMerge =
        (currentScript === 'han' || currentScript === 'kana') &&
        (script === 'han' || script === 'kana');
      if (!shouldMerge) {
        chunks.push({ text: current, script: currentScript });
        current = '';
      }
    }

    if (!current) currentScript = script;
    if (currentScript === 'other') currentScript = script;
    if (currentScript === 'han' && (script === 'kana' || script === 'han')) currentScript = 'kana';
    if (currentScript === 'kana' && (script === 'han' || script === 'kana')) currentScript = 'kana';

    current += ch;
    if (currentScript === 'other') currentScript = script;
  }

  if (current) {
    chunks.push({ text: current, script: currentScript });
  }

  return chunks;
}

let _zhSegmenter: Intl.Segmenter | null = null;
let _jaSegmenter: Intl.Segmenter | null = null;
let _koSegmenter: Intl.Segmenter | null = null;

function getZhSegmenter(): Intl.Segmenter {
  if (!_zhSegmenter) _zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  return _zhSegmenter;
}

function getJaSegmenter(): Intl.Segmenter {
  if (!_jaSegmenter) _jaSegmenter = new Intl.Segmenter('ja', { granularity: 'word' });
  return _jaSegmenter;
}

function getKoSegmenter(): Intl.Segmenter {
  if (!_koSegmenter) _koSegmenter = new Intl.Segmenter('ko', { granularity: 'word' });
  return _koSegmenter;
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
    switch (chunk.script) {
      case 'hangul':
        tokens.push(segmentByIntl(chunk.text, getKoSegmenter()));
        break;
      case 'kana':
        tokens.push(segmentByIntl(chunk.text, getJaSegmenter()));
        break;
      case 'han':
        tokens.push(segmentByIntl(chunk.text, getZhSegmenter()));
        break;
      default:
        tokens.push(chunk.text);
        break;
    }
  }

  return tokens.filter(Boolean).join(' ');
}
