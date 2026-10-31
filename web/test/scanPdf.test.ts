import assert from "node:assert/strict";
import { test } from "node:test";
import { jpegsToPdf } from "../src/scanPdf.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

test("one page per photo, in order", () => {
  const pdf = latin1(jpegsToPdf([{ data: jpeg, width: 850, height: 1100 }, { data: jpeg, width: 1100, height: 850 }]));
  assert.match(pdf, /^%PDF-1\.4\n/);
  assert.match(pdf, /\/Type \/Pages \/Count 2 \/Kids \[3 0 R 6 0 R\]/);
  // Portrait fills Letter; landscape gets landscape Letter.
  assert.match(pdf, /3 0 obj\n<< \/Type \/Page [^\n]*\/MediaBox \[0 0 612 792\]/);
  assert.match(pdf, /6 0 obj\n<< \/Type \/Page [^\n]*\/MediaBox \[0 0 792 612\]/);
  assert.match(pdf, /\/Width 850 \/Height 1100 [^\n]*\/Filter \/DCTDecode \/Length 9 >>/);
  assert.match(pdf, /%%EOF\n$/);
});

test("xref offsets point at their objects", () => {
  const bytes = jpegsToPdf([{ data: jpeg, width: 10, height: 20 }]);
  const pdf = latin1(bytes);
  const startxref = Number(/startxref\n(\d+)\n/.exec(pdf)![1]);
  assert.equal(pdf.slice(startxref, startxref + 4), "xref");
  const entries = pdf.slice(startxref).split("\n").slice(3, 8);
  entries.forEach((e, i) => {
    const off = Number(e.slice(0, 10));
    assert.equal(pdf.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
});

test("rejects an empty scan", () => {
  assert.throws(() => jpegsToPdf([]));
});
