import { describe, it, expect } from 'vitest';
import { cleanText } from '../../../src/services/cleaner';

describe('cleanText', () => {
  it('normalizes whitespace: collapses multiple spaces', () => {
    expect(cleanText('hello   world')).toBe('hello world');
  });

  it('normalizes whitespace: collapses multiple newlines', () => {
    expect(cleanText('hello\n\n\nworld')).toBe('hello\nworld');
  });

  it('normalizes whitespace: collapses mixed whitespace', () => {
    expect(cleanText('hello \n \n world')).toBe('hello\nworld');
  });

  it('normalizes whitespace: trims leading and trailing', () => {
    expect(cleanText('  hello  ')).toBe('hello');
  });

  it('strips control characters but keeps \\n', () => {
    expect(cleanText('hello\u0007world')).toBe('helloworld');
    expect(cleanText('hello\nworld')).toBe('hello\nworld');
  });

  it('strips control characters but keeps \\t', () => {
    expect(cleanText('hello\tworld')).toBe('hello\tworld');
    expect(cleanText('hello\u0001world')).toBe('helloworld');
  });

  it('removes HTML tags', () => {
    expect(cleanText('<p>Hello</p>')).toBe('Hello');
    expect(cleanText('<div class="foo">bar</div>')).toBe('bar');
  });

  it('removes HTML tags with attributes', () => {
    expect(cleanText('<a href="http://example.com">link</a>')).toBe('link');
  });

  it('handles NFC Unicode normalization', () => {
    const nfd = 'e\u0301';
    const nfc = '\u00e9';
    expect(cleanText(nfd)).toBe(nfc);
  });

  it('handles empty string', () => {
    expect(cleanText('')).toBe('');
  });

  it('handles text with mixed issues', () => {
    const input = '  <b>Hello</b>  \u0000  World  \n\n  <i>!</i>  ';
    expect(cleanText(input)).toBe('Hello World\n!');
  });

  it('preserves single spaces and newlines', () => {
    expect(cleanText('hello world\nfoo bar')).toBe('hello world\nfoo bar');
  });
});
