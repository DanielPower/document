import assert from "node:assert/strict";
import { test } from "node:test";
import { findIn, needlesFor, provenance } from "../src/provenance.ts";

const text = `KINGSWAY AUTO SERVICE                   Invoice #10871
                                      Date: 2026-10-28
Vehicle: Honda Civic Plate CNKJ 482
HST 15%                                        12.53
TOTAL CAD                                     96.05
Annual premium                            1,284.00
Due on receipt`;

const money = { type: "money", options: { currency: "CAD" } } as const;
const f = (type: string) => ({ type, options: {} }) as never;

test("money is found in its printed forms", () => {
  assert.equal(provenance(money, 96.05, text).kind, "read");
  assert.equal(provenance(money, 1284, text).kind, "read");
});

test("a number inside a longer number doesn't count", () => {
  assert.equal(findIn("Total 196.05", needlesFor(money, 96.05)), null);
  assert.equal(findIn("Total 96.051", needlesFor(money, 96.05)), null);
  assert.equal(findIn("Total 1,296.05", needlesFor(money, 96.05)), null);
});

test("a value that isn't in the text is inferred", () => {
  assert.equal(provenance(money, 83.52, text).kind, "inferred");
  assert.equal(provenance(f("date"), "2026-11-27", text).kind, "inferred");
});

test("dates match other formats", () => {
  assert.equal(findIn("Issued Oct 28, 2026", needlesFor(f("date"), "2026-10-28")), "Oct 28, 2026");
  assert.equal(findIn("Issued 28 October 2026", needlesFor(f("date"), "2026-10-28")), "28 October 2026");
  assert.equal(provenance(f("date"), "2026-10-28", text).kind, "read");
});

test("text matches ignoring case and spacing", () => {
  assert.equal(provenance(f("text"), "Kingsway Auto Service", text).kind, "read");
  assert.equal(provenance(f("text"), "10871", text).kind, "read");
  assert.equal(provenance(f("text"), "Mr Lube", text).kind, "inferred");
});

test("yes/no answers are judgments; links have nothing to check", () => {
  assert.equal(provenance(f("boolean"), false, text).kind, "inferred");
  assert.equal(provenance(f("ref"), "some-id", text).kind, "none");
  assert.equal(provenance(f("text"), null, text).kind, "none");
});

test("no text (a photo before OCR) means nothing can be checked", () => {
  assert.equal(provenance(money, 96.05, "").kind, "none");
});

import { parseDate, parseNumber } from "../src/parse.ts";

test("typed dates", () => {
  assert.equal(parseDate("2026-10-28"), "2026-10-28");
  assert.equal(parseDate("2026/1/5"), "2026-01-05");
  assert.equal(parseDate("Oct 28, 2026"), "2026-10-28");
  assert.equal(parseDate("28 October 2026"), "2026-10-28");
  assert.equal(parseDate("28/10/2026"), "2026-10-28");
  assert.equal(parseDate("10/11/2026"), undefined); // ambiguous
  assert.equal(parseDate("2026-02-30"), undefined);
  assert.equal(parseDate(""), null);
});

test("typed amounts", () => {
  assert.equal(parseNumber("1,284.00"), 1284);
  assert.equal(parseNumber("96.05"), 96.05);
  assert.equal(parseNumber("1 284,50"), 1284.5);
  assert.equal(parseNumber("$12"), 12);
  assert.equal(parseNumber("abc"), undefined);
  assert.equal(parseNumber(""), null);
});
