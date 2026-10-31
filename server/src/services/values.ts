import type { DraftValue, FieldDef } from "../shared/types.js";

export interface StoredValue {
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
  value_bool: boolean | null;
  value_ref: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Parses "$1,234.56", "1 234,56", "(12.00)" and similar into a number. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s) || /^[^\d]*-/.test(s) || /-\s*$/.test(s);
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > lastDot && s.length - lastComma - 1 !== 3) {
    // comma is the decimal separator ("1.234,56" or "12,5")
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Accepts YYYY-MM-DD and anything Date can parse; returns YYYY-MM-DD or null. */
export function parseDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    if (dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d) return `${y}-${m}-${d}`;
    return null;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const dt = new Date(t);
  // Date.parse without a zone yields local time; use local parts.
  const y = dt.getFullYear();
  if (y < 1900 || y > 2200) return null;
  return `${y}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export function parseBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "paid"].includes(s)) return true;
  if (["false", "no", "n", "0", "unpaid"].includes(s)) return false;
  return null;
}

/**
 * Normalizes a loosely-typed value (from the AI or a form) to the draft
 * representation for the field's type. Returns undefined when the value can't
 * be interpreted, so callers can report it.
 */
export function normalizeDraftValue(field: Pick<FieldDef, "type" | "options">, raw: unknown): DraftValue | undefined {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (field.type) {
    case "number":
    case "money": {
      const n = parseNumber(raw);
      return n === null ? undefined : n;
    }
    case "boolean": {
      const b = parseBool(raw);
      return b === null ? undefined : b;
    }
    case "date":
      return parseDate(raw) ?? undefined;
    case "select": {
      const s = String(raw).trim();
      const choices = field.options.choices ?? [];
      const match = choices.find((c) => c.toLowerCase() === s.toLowerCase());
      return match ?? undefined;
    }
    case "ref": {
      const s = String(raw).trim();
      return isUuid(s) || s.startsWith("new:") ? s : undefined;
    }
    default:
      return String(raw);
  }
}

/** Converts a normalized draft value into the typed storage columns. Refs must already be resolved to ids. */
export function toStored(field: Pick<FieldDef, "type">, value: DraftValue): StoredValue | null {
  if (value === null || value === "") return null;
  const out: StoredValue = { value_text: null, value_number: null, value_date: null, value_bool: null, value_ref: null };
  switch (field.type) {
    case "number":
    case "money":
      out.value_number = value as number;
      break;
    case "boolean":
      out.value_bool = value as boolean;
      break;
    case "date":
      out.value_date = value as string;
      break;
    case "ref":
      out.value_ref = value as string;
      break;
    default:
      out.value_text = String(value);
  }
  return out;
}

export function fromStored(field: Pick<FieldDef, "type">, v: StoredValue): DraftValue {
  switch (field.type) {
    case "number":
    case "money":
      return v.value_number;
    case "boolean":
      return v.value_bool;
    case "date":
      return v.value_date;
    case "ref":
      return v.value_ref;
    default:
      return v.value_text;
  }
}

export function formatValue(field: Pick<FieldDef, "type" | "options">, value: DraftValue, refTitles?: Map<string, string>): string {
  if (value === null || value === undefined) return "";
  if (field.type === "money") return `${(value as number).toFixed(2)}${field.options.currency ? " " + field.options.currency : ""}`;
  if (field.type === "boolean") return value ? "yes" : "no";
  if (field.type === "ref") return refTitles?.get(String(value)) ?? String(value);
  return String(value);
}
