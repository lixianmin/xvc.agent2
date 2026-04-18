import { describe, it, expect, vi } from 'vitest';

describe('parseFile', () => {
  async function getParseFile() {
    const { parseFile } = await import('../../../src/services/parser');
    return parseFile;
  }

  it('parses .txt and returns decoded text', async () => {
    const parseFile = await getParseFile();
    const text = 'Hello, world!';
    const buffer = new TextEncoder().encode(text).buffer;
    const result = await parseFile(buffer, 'text/plain', 'hello.txt');
    expect(result).toBe(text);
  });

  it('parses .md and returns decoded text', async () => {
    const parseFile = await getParseFile();
    const text = '# Title\nSome **markdown**';
    const buffer = new TextEncoder().encode(text).buffer;
    const result = await parseFile(buffer, 'text/markdown', 'doc.md');
    expect(result).toBe(text);
  });

  it('handles UTF-8 encoded txt files', async () => {
    const parseFile = await getParseFile();
    const text = '你好世界 🌍';
    const buffer = new TextEncoder().encode(text).buffer;
    const result = await parseFile(buffer, 'text/plain', 'chinese.txt');
    expect(result).toBe(text);
  });

  it('throws error for unsupported MIME type', async () => {
    const parseFile = await getParseFile();
    const buffer = new ArrayBuffer(0);
    await expect(parseFile(buffer, 'application/zip', 'file.zip')).rejects.toThrow(
      /unsupported/i,
    );
  });

  it('throws error for unsupported file extension', async () => {
    const parseFile = await getParseFile();
    const buffer = new ArrayBuffer(0);
    await expect(parseFile(buffer, 'image/bmp', 'photo.bmp')).rejects.toThrow(
      /unsupported/i,
    );
  });

  describe('PDF parsing', () => {
    it('calls unpdf with buffer and returns text', async () => {
      vi.doMock('unpdf', () => ({
        getDocumentProxy: vi.fn().mockResolvedValue({}),
        extractText: vi.fn().mockResolvedValue({ totalPages: 1, text: 'PDF content here' }),
      }));

      vi.resetModules();

      const { parseFile } = await import('../../../src/services/parser');
      const buffer = new ArrayBuffer(4);
      const result = await parseFile(buffer, 'application/pdf', 'doc.pdf');
      expect(result).toBe('PDF content here');

      vi.doUnmock('unpdf');
      vi.resetModules();
    });
  });

  describe('DOCX parsing', () => {
    it('calls mammoth with buffer and returns text', async () => {
      vi.doMock('mammoth', () => ({
        extractRawText: vi.fn().mockResolvedValue({ value: 'DOCX content here' }),
      }));

      vi.resetModules();

      const { parseFile } = await import('../../../src/services/parser');
      const buffer = new ArrayBuffer(4);
      const result = await parseFile(buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx');
      expect(result).toBe('DOCX content here');

      vi.doUnmock('mammoth');
      vi.resetModules();
    });
  });

  describe('Image parsing', () => {
    it('calls visionClient.describeImage for image files', async () => {
      const mockClient = {
        describeImage: vi.fn().mockResolvedValue('OCR text from image'),
      } as any;

      vi.resetModules();
      const { parseFile } = await import('../../../src/services/parser');
      const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

      const result = await parseFile(buffer, 'image/png', 'photo.png', { visionClient: mockClient });
      expect(result).toBe('OCR text from image');
      expect(mockClient.describeImage).toHaveBeenCalledTimes(1);
      expect(mockClient.describeImage.mock.calls[0][0]).toContain('data:image/png;base64,');
    });

    it('throws if image file has no visionClient', async () => {
      vi.resetModules();
      const { parseFile } = await import('../../../src/services/parser');
      const buffer = new ArrayBuffer(4);
      await expect(parseFile(buffer, 'image/png', 'photo.png')).rejects.toThrow(/vision/i);
    });
  });
});
