import type { LLMClient } from '../llm/client';
import { log } from './logger';

export async function parseFile(
  buffer: ArrayBuffer,
  mimeType: string,
  filename: string,
  options?: { visionClient?: LLMClient },
): Promise<string> {
  const ext = filename.toLowerCase().split('.').pop() ?? '';

  if (ext === 'txt' || ext === 'md') {
    return new TextDecoder().decode(buffer);
  }

  if (ext === 'pdf') {
    try {
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    } catch (e) {
      throw new Error(`Failed to parse PDF: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (ext === 'docx') {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
      return result.value;
    } catch (e) {
      throw new Error(`Failed to parse DOCX: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
  if (imageExts.includes(ext)) {
    if (!options?.visionClient) {
      throw new Error(`Image parsing requires a vision client: ${filename}`);
    }
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const dataUrl = `data:${mimeType};base64,${base64}`;
    log.info('parser:image', 'vision OCR start', { filename, size: buffer.byteLength });
    const text = await options.visionClient.describeImage(dataUrl,
      '请提取图片中的所有文字内容。如有表格请转为 Markdown 表格，如有数学公式请转为 LaTeX 格式。然后简要描述图片的主要内容。',
    );
    log.info('parser:image', 'vision OCR end', { filename });
    return text;
  }

  throw new Error(`Unsupported file type: ${filename} (${mimeType})`);
}
