/**
 * Splits text into chunks of roughly chunkChars, preferring paragraph and
 * sentence boundaries, with a little overlap so facts split across a boundary
 * still appear whole in one chunk.
 */
export function chunkText(text: string, size: number): string[] {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const overlap = Math.floor(size * 0.15);
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size * 0.5), end);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
      const cut = para >= 0 ? para : sentence;
      if (cut >= 0) end = start + Math.floor(size * 0.5) + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}
