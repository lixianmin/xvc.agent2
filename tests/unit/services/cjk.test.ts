import { describe, it, expect } from 'vitest';
import { tokenizeCJK, containsCJK } from '../../../src/services/cjk';

describe('CJK tokenizer', () => {
  it('passes through non-CJK text unchanged', () => {
    expect(tokenizeCJK('hello world')).toBe('hello world');
  });

  it('splits Chinese text into words with spaces', () => {
    const result = tokenizeCJK('人工智能技术');
    expect(result).toContain(' ');
    expect(result.split(' ').length).toBeGreaterThan(1);
  });

  it('detects CJK presence', () => {
    expect(containsCJK('hello')).toBe(false);
    expect(containsCJK('你好')).toBe(true);
  });

  it('handles mixed CJK and ASCII', () => {
    const result = tokenizeCJK('使用RAG技术');
    expect(result).toContain('RAG');
    expect(result).toContain(' ');
  });

  it('handles empty string', () => {
    expect(tokenizeCJK('')).toBe('');
  });

  it('does not segment non-CJK scripts', () => {
    expect(tokenizeCJK('hello world')).toBe('hello world');
  });
});
