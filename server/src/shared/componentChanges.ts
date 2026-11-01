// Pure helpers for Draft.componentChanges, shared by the server and the web UI.
import type { DraftComponentChange, FieldDef } from "./types.ts";

type FieldLike = Pick<FieldDef, "key" | "label" | "required">;

/** The definition as it will be once the change is applied. */
export function withChange<F extends FieldLike, D extends { fields: F[] }>(def: D, change: DraftComponentChange | undefined): D {
  if (!change) return def;
  const fields = def.fields.map((f) => (change.required && f.key in change.required ? { ...f, required: change.required[f.key] } : f));
  const keys = new Set(fields.map((f) => f.key));
  const added = (change.addFields ?? []).filter((f) => !keys.has(f.key)) as unknown as F[];
  return { ...def, fields: [...fields, ...added] };
}

/** What the change does, in short phrases: "Principal no longer required", "adds Credit limit". */
export function describeChange(def: { fields: FieldLike[] }, change: DraftComponentChange): string[] {
  const out: string[] = [];
  for (const [key, required] of Object.entries(change.required ?? {})) {
    const f = def.fields.find((x) => x.key === key);
    if (!f || f.required === required) continue;
    out.push(required ? `${f.label} becomes required` : `${f.label} no longer required`);
  }
  for (const f of change.addFields ?? []) {
    if (!def.fields.some((x) => x.key === f.key)) out.push(`adds ${f.label || f.key}${f.required ? " (required)" : ""}`);
  }
  return out;
}

/** True when the change would do nothing to this definition. */
export function isNoopChange(def: { fields: FieldLike[] }, change: DraftComponentChange): boolean {
  return describeChange(def, change).length === 0;
}
