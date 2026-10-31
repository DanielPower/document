import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDraftValue, parseDate, parseNumber } from "../src/services/values.ts";

test("parseNumber handles currency formats", () => {
  assert.equal(parseNumber("$1,234.56"), 1234.56);
  assert.equal(parseNumber("1.234,56 €"), 1234.56);
  assert.equal(parseNumber("12,5"), 12.5);
  assert.equal(parseNumber("1,234"), 1234);
  assert.equal(parseNumber("(45.00)"), -45);
  assert.equal(parseNumber("-3"), -3);
  assert.equal(parseNumber("CAD 99"), 99);
  assert.equal(parseNumber("abc"), null);
  assert.equal(parseNumber(7), 7);
});

test("parseDate normalizes to YYYY-MM-DD and rejects impossible dates", () => {
  assert.equal(parseDate("2025-03-14"), "2025-03-14");
  assert.equal(parseDate("March 14, 2025"), "2025-03-14");
  assert.equal(parseDate("2025-02-30"), null);
  assert.equal(parseDate("not a date"), null);
});

test("normalizeDraftValue respects field types", () => {
  assert.equal(normalizeDraftValue({ type: "boolean", options: {} }, "yes"), true);
  assert.equal(normalizeDraftValue({ type: "boolean", options: {} }, "maybe"), undefined);
  assert.equal(normalizeDraftValue({ type: "select", options: { choices: ["Monthly", "Yearly"] } }, "yearly"), "Yearly");
  assert.equal(normalizeDraftValue({ type: "select", options: { choices: ["Monthly"] } }, "Weekly"), undefined);
  assert.equal(normalizeDraftValue({ type: "ref", options: {} }, "new:car1"), "new:car1");
  assert.equal(normalizeDraftValue({ type: "ref", options: {} }, "the car"), undefined);
  assert.equal(normalizeDraftValue({ type: "money", options: {} }, ""), null);
});

test("normalizeIdentifier ignores case, spaces and punctuation", async () => {
  const { normalizeIdentifier } = await import("../src/services/values.ts");
  assert.equal(normalizeIdentifier("JRO 686"), normalizeIdentifier("jro-686"));
  assert.equal(normalizeIdentifier("jm1bpaml5n1518380"), "JM1BPAML5N1518380");
  assert.equal(normalizeIdentifier(12345), "12345");
  assert.equal(normalizeIdentifier(null), "");
  assert.equal(normalizeIdentifier(true), "");
});
