type Chunk = {
  content: string;
  seq: number;
  tokenCount: number;
};

type BreakPoint = {
  pos: number;
  score: number;
  type: string;
};

type CodeFenceRegion = {
  start: number;
  end: number;
};

const TARGET_TOKENS = 500;
const OVERLAP_TOKENS = 75;
const WINDOW_TOKENS = 100;
const CHARS_PER_TOKEN = 4;

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;
const WINDOW_CHARS = WINDOW_TOKENS * CHARS_PER_TOKEN;

const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n(?=#{1}(?!#))/g, 100, 'h1'],
  [/\n(?=#{2}(?!#))/g, 90, 'h2'],
  [/\n(?=#{3}(?!#))/g, 80, 'h3'],
  [/\n```/g, 70, 'codeblock'],
  [/\n(?:---|\*\*\*)\s*\n/g, 60, 'hr'],
  [/\n\n+/g, 20, 'blank'],
  [/\n/g, 1, 'newline'],
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function scanBreakPoints(text: string): BreakPoint[] {
  const seen = new Map<number, BreakPoint>();

  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index! + 1;
      const existing = seen.get(pos);
      if (!existing || score > existing.score) {
        seen.set(pos, { pos, score, type });
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos);
}

function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const pattern = /\n```/g;
  let inFence = false;
  let fenceStart = 0;

  for (const match of text.matchAll(pattern)) {
    if (!inFence) {
      fenceStart = match.index!;
      inFence = true;
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length });
      inFence = false;
    }
  }

  if (inFence) {
    regions.push({ start: fenceStart, end: text.length });
  }

  return regions;
}

function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some(f => pos > f.start && pos < f.end);
}

function findBestCutoff(
  breakPoints: BreakPoint[],
  targetPos: number,
  windowChars: number,
  codeFences: CodeFenceRegion[],
): number {
  const windowStart = targetPos - windowChars;
  let bestScore = -1;
  let bestPos = targetPos;

  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue;
    if (bp.pos > targetPos) break;

    if (isInsideCodeFence(bp.pos, codeFences)) continue;

    const distance = targetPos - bp.pos;
    const normalizedDist = distance / windowChars;
    const multiplier = 1.0 - normalizedDist * normalizedDist * 0.7;
    const finalScore = bp.score * multiplier;

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPos = bp.pos;
    }
  }

  return bestPos;
}

export function chunkText(text: string): Chunk[] {
  if (!text) return [];

  if (text.length <= TARGET_CHARS) {
    return [{ content: text, seq: 0, tokenCount: estimateTokens(text) }];
  }

  const breakPoints = scanBreakPoints(text);
  const codeFences = findCodeFences(text);
  const chunks: Chunk[] = [];
  let charPos = 0;
  let seq = 0;

  while (charPos < text.length) {
    const targetEnd = Math.min(charPos + TARGET_CHARS, text.length);
    let endPos = targetEnd;

    if (endPos < text.length) {
      const bestCutoff = findBestCutoff(breakPoints, targetEnd, WINDOW_CHARS, codeFences);
      if (bestCutoff > charPos && bestCutoff <= targetEnd) {
        endPos = bestCutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + TARGET_CHARS, text.length);
    }

    const content = text.slice(charPos, endPos);
    chunks.push({ content, seq, tokenCount: estimateTokens(content) });

    if (endPos >= text.length) break;

    seq++;
    const nextPos = endPos - OVERLAP_CHARS;
    const candidate = nextPos > charPos ? nextPos : endPos;
    charPos = isInsideCodeFence(candidate, codeFences) ? endPos : candidate;
  }

  return chunks;
}

export type { Chunk };
