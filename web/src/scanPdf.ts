/**
 * Builds a PDF from JPEG photos, one page per photo, so a multi-page scan from
 * the phone's camera arrives as one document. JPEG data is embedded as-is
 * (DCTDecode), so this needs no PDF library.
 */
export type JpegPage = { data: Uint8Array; width: number; height: number };

/** Pages are sized so the photo fits on Letter paper; OCR reads the DPI from this. */
function pageSize(w: number, h: number): [number, number] {
  const [shortIn, longIn] = [8.5, 11];
  const dpi = w <= h ? Math.max(w / shortIn, h / longIn) : Math.max(w / longIn, h / shortIn);
  return [round2((w * 72) / dpi), round2((h * 72) / dpi)];
}
const round2 = (n: number) => Math.round(n * 100) / 100;

export function jpegsToPdf(pages: JpegPage[]): Uint8Array {
  if (!pages.length) throw new Error("no pages");
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (c: Uint8Array | string) => {
    const bytes = typeof c === "string" ? enc.encode(c) : c;
    chunks.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };

  // Objects: 1 catalog, 2 page tree, then per page i: page, content, image.
  const pageObj = (i: number) => 3 + i * 3;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`));
  pages.forEach((p, i) => {
    const [w, h] = pageSize(p.width, p.height);
    const n = pageObj(i);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(n, () =>
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`),
    );
    obj(n + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(n + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.data.length} >>\nstream\n`);
      push(p.data);
      push("\nendstream");
    });
  });

  const count = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
