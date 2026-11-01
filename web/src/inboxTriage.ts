/*
 * What an inbox document needs from you, worked out from its proposal: the
 * list groups documents by it, shows the key values and one effect line, and
 * only documents with nothing to decide can be filed in a batch.
 */
import { defsFor, display, rankMatches } from "./components/DraftEditor";
import { describeChange } from "../../server/src/shared/componentChanges.ts";
import type { ComponentDef, DocumentSummary, Draft, ObjectSummary } from "./types";

export type Group = "needs" | "ready" | "processing" | "failed";

export interface Effects {
  /** Titles of objects filing creates. */
  creates: string[];
  /** "2019 Honda Civic: Licence plate" for each existing object it changes. */
  updates: string[];
  /** Names of component definitions it creates. */
  newComponents: string[];
  /** "Loan: Principal no longer required" for each existing definition it changes. */
  changedComponents: string[];
  /** Titles of existing objects it links to. */
  links: string[];
}

export interface Triage {
  group: Group;
  /** Why it needs you, e.g. "Same as “2019 Honda Civic”?" */
  questions: string[];
  /** A name-like value and an amount, for the list row. */
  who?: string;
  amount?: string;
  effects?: Effects;
}

export const ACTIVE = ["queued", "ocr", "analyzing"];

export function effectsOf(draft: Draft, catalog: ComponentDef[], objects: ObjectSummary[]): Effects {
  const defs = defsFor(catalog, draft);
  const title = (id: string) => objects.find((o) => o.id === id)?.title ?? "an object";
  const links = new Set<string>();
  for (const c of draft.components) {
    for (const f of defs.get(c.component)?.fields ?? []) {
      const v = c.values[f.key];
      if (f.type === "ref" && typeof v === "string" && !v.startsWith("new:")) links.add(title(v));
    }
  }
  return {
    creates: draft.newObjects.map((o) => o.title),
    updates: (draft.objectUpdates ?? []).map((u) => {
      const labels = u.components.flatMap((c) => {
        const def = defs.get(c.component);
        return Object.keys(c.values).map((k) => def?.fields.find((f) => f.key === k)?.label ?? k);
      });
      return `${title(u.objectId)}: ${labels.join(", ")}`;
    }),
    newComponents: draft.newComponents.map((c) => c.name || c.key),
    changedComponents: (draft.componentChanges ?? []).flatMap((ch) => {
      const def = catalog.find((c) => c.key === ch.component);
      return def ? [`${def.name}: ${describeChange(def, ch).join(", ")}`] : [];
    }),
    links: [...links],
  };
}

/** Questions a person should answer before this draft is filed. */
export function questionsOf(draft: Draft, catalog: ComponentDef[], objects: ObjectSummary[], dismissed: (tempId: string) => boolean = () => false): string[] {
  const defs = defsFor(catalog, draft);
  const out: string[] = [];
  for (const o of draft.newObjects) {
    const best = rankMatches(o, objects).likely[0];
    if (best && !dismissed(o.tempId)) out.push(`Same as “${best.title}”?`);
  }
  for (const nc of draft.newComponents) out.push(`New component “${nc.name || nc.key}”`);
  for (const ch of draft.componentChanges ?? []) out.push(`Change component “${catalog.find((c) => c.key === ch.component)?.name ?? ch.component}”`);
  for (const c of draft.components) {
    for (const f of defs.get(c.component)?.fields ?? []) {
      const v = c.values[f.key];
      if (f.required && (v === null || v === undefined || v === "")) out.push(`${f.label} is missing`);
    }
  }
  return out;
}

export function triage(
  doc: DocumentSummary,
  draft: Draft | undefined,
  catalog: ComponentDef[],
  objects: ObjectSummary[],
  dismissed?: (tempId: string) => boolean,
): Triage {
  if (ACTIVE.includes(doc.status)) return { group: "processing", questions: [] };
  if (doc.status === "failed") return { group: "failed", questions: [] };
  if (!draft) return { group: "needs", questions: [doc.error ? "No proposal: fill in by hand" : "No proposal yet"] };
  const defs = defsFor(catalog, draft);
  let who: string | undefined;
  let amount: string | undefined;
  for (const c of draft.components) {
    for (const f of defs.get(c.component)?.fields ?? []) {
      const v = c.values[f.key];
      if (v === null || v === undefined || v === "") continue;
      if (!who && f.type === "text" && !f.options.identifier) who = String(v);
      if (!amount && f.type === "money" && typeof v === "number") amount = display({ ...f, options: {} }, v, objects);
    }
  }
  const questions = questionsOf(draft, catalog, objects, dismissed);
  return { group: questions.length ? "needs" : "ready", questions, who, amount, effects: effectsOf(draft, catalog, objects) };
}

/** "File · creates 1 object, updates 1 object": the button says what filing does. */
export function fileLabel(draft: Draft): string {
  const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (draft.newObjects.length) parts.push(`creates ${n(draft.newObjects.length, "object")}`);
  if (draft.objectUpdates?.length) parts.push(`updates ${n(draft.objectUpdates.length, "object")}`);
  if (draft.newComponents.length) parts.push(`adds ${n(draft.newComponents.length, "component")}`);
  if (draft.componentChanges?.length) parts.push(`changes ${n(draft.componentChanges.length, "component")}`);
  return parts.length ? `File · ${parts.join(", ")}` : "File";
}
