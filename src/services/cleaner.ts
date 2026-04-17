export function cleanText(text: string): string {
  let result = text.normalize('NFC');

  result = result.replace(/<[^>]*>/g, '');

  result = result.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  result = result.replace(/[^\S\n\t]+/g, ' ');
  result = result.replace(/\n[ \t]+\n/g, '\n\n');
  result = result.replace(/\n{2,}/g, '\n');
  result = result.replace(/[ \t]+\n/g, '\n');
  result = result.replace(/\n[ \t]+/g, '\n');

  result = result.trim();

  return result;
}
