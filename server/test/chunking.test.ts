import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkText } from "../src/services/chunking.ts";

test("short text is one chunk", () => {
  assert.deepEqual(chunkText("  Hello   world  ", 100), ["Hello world"]);
  assert.deepEqual(chunkText("   ", 100), []);
});

test("long text splits near the size, at paragraph or sentence breaks, with overlap", () => {
  const para = (n: number) => `Paragraph ${n}. ` + "Some words here. ".repeat(12);
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join("\n\n");
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk too long: ${c.length}`);
  // Every paragraph start appears in some chunk (nothing is lost).
  for (let i = 0; i < 12; i++) assert.ok(chunks.some((c) => c.includes(`Paragraph ${i}.`)));
  // Consecutive chunks overlap a little.
  assert.ok(chunks.slice(1).some((c, i) => chunks[i].endsWith(c.slice(0, 20)) || chunks[i].includes(c.slice(0, 20))));
});

test("text without breaks is still split", () => {
  const chunks = chunkText("x".repeat(2500), 1000);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 1000));
});
