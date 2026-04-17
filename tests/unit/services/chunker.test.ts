import { describe, it, expect } from 'vitest';
import { chunkText } from '../../../src/services/chunker';

function makeLongText(tokenCount: number): string {
  const charCount = tokenCount * 4;
  const word = 'abcdefghij';
  const repeats = Math.ceil(charCount / word.length);
  return (word + ' ').repeat(repeats).slice(0, charCount);
}

function makeMarkdownHeadings(count: number, level: number, tokensPerSection: number): string {
  const prefix = '#'.repeat(level) + ' ';
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(prefix + 'Heading ' + i + '\n' + makeLongText(tokensPerSection));
  }
  return parts.join('\n');
}

describe('chunkText', () => {
  it('returns empty array for empty string', () => {
    expect(chunkText('')).toEqual([]);
  });

  it('handles short text as single chunk', () => {
    const text = 'Hello world, this is a short text.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].seq).toBe(0);
    expect(chunks[0].tokenCount).toBe(Math.ceil(text.length / 4));
  });

  it('splits at heading boundaries', () => {
    const section = makeLongText(300) + '\n';
    const text = section + '# Heading A\n' + makeLongText(300) + '\n' + '# Heading B\n' + makeLongText(300);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      if (chunk !== chunks[chunks.length - 1]) {
        expect(chunk.content).not.toContain('# Heading B');
      }
    }
  });

  it('respects target size ~500 tokens (no chunk exceeds ~700 tokens)', () => {
    const text = makeLongText(2000);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(700);
    }
  });

  it('does not break inside code fences', () => {
    const codeBlock = '\n```javascript\n' + 'const x = 1;\n'.repeat(80) + '```\n';
    const text = makeLongText(200) + codeBlock + makeLongText(300);
    const chunks = chunkText(text);
    const totalFences = chunks.reduce((acc, c) => {
      return acc + (c.content.match(/```/g) || []).length;
    }, 0);
    expect(totalFences % 2).toBe(0);
    for (const chunk of chunks) {
      const fencesInChunk = (chunk.content.match(/```/g) || []).length;
      if (fencesInChunk > 0) {
        expect(fencesInChunk % 2).toBe(0);
      }
    }
  });

  it('handles text with multiple heading levels', () => {
    const text = [
      '# Chapter 1',
      makeLongText(200),
      '## Section 1.1',
      makeLongText(200),
      '### Sub 1.1.1',
      makeLongText(200),
      '## Section 1.2',
      makeLongText(200),
      '# Chapter 2',
      makeLongText(200),
    ].join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeGreaterThan(0);
    }
    expect(chunks.every((c, i) => c.seq === i)).toBe(true);
  });

  it('assigns sequential seq numbers starting from 0', () => {
    const text = makeLongText(1500);
    const chunks = chunkText(text);
    expect(chunks.map(c => c.seq)).toEqual(chunks.map((_, i) => i));
  });

  it('each chunk has correct tokenCount', () => {
    const text = makeLongText(1200);
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBe(Math.ceil(chunk.content.length / 4));
    }
  });

  it('handles horizontal rules as break points', () => {
    const text = makeLongText(400) + '\n---\n' + makeLongText(400);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles text with only newlines', () => {
    const text = 'line1\nline2\nline3\nline4';
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].content.length).toBeGreaterThan(0);
  });

  it('overlap causes some content repetition between consecutive chunks', () => {
    const text = makeLongText(1500);
    const chunks = chunkText(text);
    if (chunks.length >= 2) {
      const overlap = chunks[0].content.slice(-100);
      const hasOverlap = chunks[1].content.includes(overlap.slice(20));
      expect(hasOverlap).toBe(true);
    }
  });
});
