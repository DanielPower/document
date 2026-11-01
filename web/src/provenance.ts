/*
 * Where a proposed value came from. A value the AI read from the document can
 * be found in the document's text; one it inferred (a "Paid: No" judged from
 * "Due on receipt", a due date worked out from "Net 30") can't. The inbox marks
 * inferred values so the review effort goes to them, and highlights the place
 * a read value came from.
 *
 * Pure functions, no DOM: shared by the inbox and the PDF/text highlighter.
 */
import type { DraftValue, FieldDef } from "./types";

type Field = Pick<FieldDef, "type" | "options">;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Lowercase, one space between words, plain quotes and dashes: how text is compared. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** "1284.5" -> ["1284.50", "1,284.50", "1284,50", "1 284,50", "1284.5"]; whole numbers also without decimals. */
function numberForms(n: number, money: boolean): string[] {
  const out = new Set<string>();
  const fixed = money || !Number.isInteger(n) ? n.toFixed(money ? 2 : Math.min(4, (String(n).split(".")[1] ?? "").length)) : String(n);
  const [int, dec] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const spaced = int.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  if (dec !== undefined) {
    out.add(`${int}.${dec}`).add(`${grouped}.${dec}`).add(`${int},${dec}`).add(`${spaced},${dec}`);
    if (/^0+$/.test(dec)) out.add(int).add(grouped);
  } else {
    out.add(int).add(grouped);
  }
  out.add(String(n));
  return [...out];
}

/** "2026-10-28" in the ways a document might print it. */
function dateForms(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [iso];
  const [, y, mo, d] = m;
  const month = MONTHS[Number(mo) - 1];
  const mon = month.slice(0, 3);
  const day = String(Number(d));
  return [
    iso, `${y}/${mo}/${d}`, `${mo}/${d}/${y}`, `${d}/${mo}/${y}`, `${day}/${Number(mo)}/${y}`, `${Number(mo)}/${day}/${y}`, `${d}.${mo}.${y}`,
    `${month} ${day}, ${y}`, `${month} ${day} ${y}`, `${mon} ${day}, ${y}`, `${mon} ${day} ${y}`, `${mon}. ${day}, ${y}`,
    `${day} ${month} ${y}`, `${day} ${mon} ${y}`, `${d} ${mon} ${y}`, `${d}-${mon}-${y}`, `${day}-${mon}-${y}`,
  ];
}

/**
 * The strings to look for in a document to find a value. Empty when there is
 * nothing to find: references and yes/no answers are judgments, not text.
 */
export function needlesFor(field: Field, value: DraftValue): string[] {
  if (value === null || value === undefined || value === "") return [];
  switch (field.type) {
    case "number":
    case "money":
      return typeof value === "number" ? numberForms(value, field.type === "money") : [String(value)];
    case "date":
      return dateForms(String(value));
    case "boolean":
    case "ref":
      return [];
    default:
      return [String(value)];
  }
}

/**
 * The first needle that occurs in the text, matched on whole tokens (so "96.05"
 * doesn't match inside "196.05"); or, for longer text values, all of their
 * words appearing somewhere. Returns what was found, or null.
 */
export function findIn(text: string, needles: string[]): string | null {
  const hay = ` ${normalize(text)} `;
  for (const n of needles) {
    const needle = normalize(n);
    if (!needle) continue;
    const at = indexOfToken(hay, needle);
    if (at >= 0) return n;
  }
  return null;
}

/** Index of `needle` in `hay` where it isn't glued to a letter or digit on either side. */
export function indexOfToken(hay: string, needle: string, from = 0): number {
  for (let i = hay.indexOf(needle, from); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1] ?? " ";
    const after = hay[i + needle.length] ?? " ";
    const glued = (c: string) => /[\p{L}\p{N}]/u.test(c);
    // A number followed by ".5" or ",5" would be a different number.
    const decimalAfter = /[.,]/.test(after) && /\d/.test(hay[i + needle.length + 1] ?? "");
    if (!glued(before) && !glued(after) && !decimalAfter && !(/\d/.test(needle[0]) && /[.,]/.test(before) && /\d/.test(hay[i - 2] ?? ""))) return i;
  }
  return -1;
}

export type Provenance =
  /** Found in the document's text. */
  | { kind: "read"; found: string }
  /** Not in the text: the AI worked it out, or it's a judgment (yes/no). */
  | { kind: "inferred"; reason: string }
  /** Nothing to check (a link to an object, an empty value). */
  | { kind: "none" };

export function provenance(field: Field, value: DraftValue, text: string): Provenance {
  if (value === null || value === undefined || value === "") return { kind: "none" };
  if (field.type === "ref") return { kind: "none" };
  if (!text.trim()) return { kind: "none" };
  if (field.type === "boolean") return { kind: "inferred", reason: "a yes/no judged from the text" };
  const found = findIn(text, needlesFor(field, value));
  if (found) return { kind: "read", found };
  if (field.type === "text" || field.type === "longtext" || field.type === "select") {
    const words = String(value).match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    if (words.length > 1 && words.every((w) => findIn(text, [w]))) return { kind: "read", found: String(value) };
  }
  return { kind: "inferred", reason: "not in the document's text" };
}
