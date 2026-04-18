export async function parseFile(
  buffer: ArrayBuffer,
  mimeType: string,
  filename: string,
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

  throw new Error(`Unsupported file type: ${filename} (${mimeType})`);
}
