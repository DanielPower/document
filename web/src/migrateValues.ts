import type { ComponentInput, DraftComponent, DraftValue } from "./types";

type FieldInput = ComponentInput["fields"][number];

/**
 * Works out which old field each new field corresponds to after a definition
 * edit, so values survive renames and reorders:
 * - same keys (possibly reordered, or other properties edited): match by key
 * - same number of fields but a key changed: a rename, match by position
 * - fields added or removed: match by key
 */
function matchFields(before: FieldInput[], after: FieldInput[]): Map<string, FieldInput> {
  const oldByKey = new Map(before.map((f) => [f.key, f]));
  const sameKeys = before.length === after.length && after.every((f) => oldByKey.has(f.key));
  const byPosition = !sameKeys && before.length === after.length;
  const out = new Map<string, FieldInput>();
  after.forEach((f, i) => {
    const old = byPosition ? before[i] : oldByKey.get(f.key);
    if (old) out.set(f.key, old);
  });
  return out;
}

/** Converts a value to a field's (possibly new) type; undefined means it can't be kept. */
export function convertValue(value: DraftValue, field: FieldInput): DraftValue | undefined {
  if (value === null || value === "") return null;
  switch (field.type) {
    case "text":
    case "longtext":
      return String(value);
    case "number":
    case "money": {
      if (typeof value === "number") return value;
      if (typeof value === "boolean") return undefined;
      // "$1,284.00" -> 1284; text without digits ("monthly") can't become a number.
      const cleaned = value.replace(/[^\d.-]/g, "");
      const n = Number(cleaned);
      return /\d/.test(cleaned) && Number.isFinite(n) ? n : undefined;
    }
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "select": {
      const match = (field.options.choices ?? []).find((c) => c.trim().toLowerCase() === String(value).trim().toLowerCase());
      return match?.trim();
    }
    case "ref":
      return typeof value === "string" ? value : undefined;
  }
}

/**
 * Rewrites the values of every use of a proposed component after its
 * definition was edited: follows renamed and moved fields, converts values
 * whose field changed type, and drops values that no longer fit (removed
 * fields, impossible conversions, select choices that were removed).
 */
export function migrateComponentValues(before: ComponentInput, after: ComponentInput, comps: DraftComponent[]): DraftComponent[] {
  const matched = matchFields(before.fields, after.fields);
  return comps.map((c) => {
    if (c.component !== before.key) return c;
    const values: DraftComponent["values"] = {};
    for (const f of after.fields) {
      const old = matched.get(f.key);
      if (!old || !(old.key in c.values)) continue;
      const v = convertValue(c.values[old.key], f);
      if (v !== undefined) values[f.key] = v;
    }
    return { component: after.key, values };
  });
}
