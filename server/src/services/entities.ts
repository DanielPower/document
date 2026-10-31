import type { Tx } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { ComponentDef, Draft, DraftComponent, DraftValue } from "../shared/types.ts";
import { componentsByKey, createComponent } from "./components.ts";
import { formatValue, fromStored, normalizeDraftValue, toStored, type StoredValue } from "./values.ts";

interface ValueRow extends StoredValue {
  entity_id: string;
  instance_id: string;
  position: number;
  component: string;
  field: string | null;
  type: string | null;
}

/** Loads the components of many entities in draft form (keyed by component/field keys). */
export async function loadComponents(tx: Tx, entityIds: string[]): Promise<Map<string, DraftComponent[]>> {
  const out = new Map<string, DraftComponent[]>(entityIds.map((id) => [id, []]));
  if (!entityIds.length) return out;
  const rows = await tx<ValueRow[]>`
    select ci.entity_id, ci.id as instance_id, ci.position, cd.key as component, fd.key as field, fd.type,
           fv.value_text, fv.value_number, fv.value_date, fv.value_bool, fv.value_ref
    from component_instance ci
    join component_def cd on cd.id = ci.component_id
    left join field_value fv on fv.instance_id = ci.id
    left join field_def fd on fd.id = fv.field_id
    where ci.entity_id = any(${entityIds}::uuid[])
    order by ci.entity_id, ci.position, ci.created_at`;
  const byInstance = new Map<string, DraftComponent>();
  for (const r of rows) {
    let comp = byInstance.get(r.instance_id);
    if (!comp) {
      comp = { component: r.component, values: {} };
      byInstance.set(r.instance_id, comp);
      out.get(r.entity_id)!.push(comp);
    }
    if (r.field && r.type) comp.values[r.field] = fromStored({ type: r.type as never }, r);
  }
  return out;
}

export async function loadDraft(tx: Tx, entityId: string): Promise<Draft> {
  const [e] = await tx<{ title: string; document_date: string | null }[]>`
    select e.title, d.document_date from entity e left join document d on d.entity_id = e.id where e.id = ${entityId}`;
  if (!e) throw new HttpError(404, "Not found.");
  const comps = await loadComponents(tx, [entityId]);
  return { title: e.title, documentDate: e.document_date, components: comps.get(entityId) ?? [], newComponents: [], newObjects: [] };
}

/** One-line human description of an object's components, e.g. "Vehicle: Honda · Civic · 2019". */
export function describeComponents(comps: DraftComponent[], catalog: Map<string, ComponentDef>, refTitles?: Map<string, string>): string {
  return comps
    .map((c) => {
      const def = catalog.get(c.component);
      if (!def) return c.component;
      const parts = def.fields
        .filter((f) => c.values[f.key] !== null && c.values[f.key] !== undefined)
        .map((f) => {
          const s = formatValue(f, c.values[f.key], refTitles).replace(/\s+/g, " ");
          return s.length > 80 ? s.slice(0, 77) + "..." : s;
        });
      return parts.length ? `${def.name}: ${parts.join(" · ")}` : def.name;
    })
    .join("; ");
}

export interface ApplyResult {
  createdComponents: string[];
  createdObjects: Record<string, string>;
}

/**
 * Applies a draft to an entity in the given transaction: creates proposed
 * component definitions and objects, then replaces the entity's components.
 */
export async function applyDraft(tx: Tx, entityId: string, draft: Draft): Promise<ApplyResult> {
  const [entity] = await tx<{ kind: string }[]>`select kind from entity where id = ${entityId} for update`;
  if (!entity) throw new HttpError(404, "Not found.");

  // 1. New component definitions. If the key already exists (e.g. another
  //    inbox item created it first) the existing definition is reused.
  const createdComponents: string[] = [];
  const existingKeys = new Set((await tx<{ key: string }[]>`select key from component_def`).map((r) => r.key));
  for (const def of draft.newComponents ?? []) {
    if (existingKeys.has(def.key)) continue;
    await createComponent(tx, def);
    existingKeys.add(def.key);
    createdComponents.push(def.key);
  }
  const catalog = await componentsByKey(tx);

  // 2. Validate everything before writing.
  const errors: string[] = [];
  validateComponents(draft.components, catalog, draft, errors, "document");
  for (const o of draft.newObjects ?? []) {
    if (!o.title?.trim()) errors.push(`New object "${o.tempId}" needs a title.`);
    validateComponents(o.components, catalog, draft, errors, `new object "${o.title || o.tempId}"`);
  }
  if (errors.length) throw new HttpError(400, errors.join("\n"));

  // 3. New objects (created first so refs between them resolve).
  const refMap = new Map<string, string>();
  for (const o of draft.newObjects ?? []) {
    const [row] = await tx<{ id: string }[]>`insert into entity (kind, title) values ('object', ${o.title.trim()}) returning id`;
    refMap.set(`new:${o.tempId}`, row.id);
  }
  for (const o of draft.newObjects ?? []) {
    await writeComponents(tx, refMap.get(`new:${o.tempId}`)!, o.components, catalog, refMap);
  }

  // 4. The entity itself.
  await writeComponents(tx, entityId, draft.components, catalog, refMap);
  await tx`update entity set title = ${draft.title?.trim() ?? ""}, updated_at = now() where id = ${entityId}`;
  if (entity.kind === "document") {
    await tx`update document set document_date = ${draft.documentDate || null}::date where entity_id = ${entityId}`;
    await tx`select refresh_document_search(${entityId})`;
  } else {
    // Documents that reference this object index its title.
    const docs = await tx<{ entity_id: string }[]>`
      select distinct ci.entity_id from field_value fv join component_instance ci on ci.id = fv.instance_id
      join document d on d.entity_id = ci.entity_id where fv.value_ref = ${entityId}`;
    for (const d of docs) await tx`select refresh_document_search(${d.entity_id})`;
  }

  return { createdComponents, createdObjects: Object.fromEntries(refMap) };
}

function validateComponents(comps: DraftComponent[], catalog: Map<string, ComponentDef>, draft: Draft, errors: string[], where: string) {
  const newIds = new Set((draft.newObjects ?? []).map((o) => `new:${o.tempId}`));
  for (const c of comps ?? []) {
    const def = catalog.get(c.component);
    if (!def) {
      errors.push(`Unknown component "${c.component}" on ${where}.`);
      continue;
    }
    for (const key of Object.keys(c.values ?? {})) {
      if (!def.fields.some((f) => f.key === key)) errors.push(`${def.name} has no field "${key}" (${where}).`);
    }
    for (const f of def.fields) {
      const raw = c.values?.[f.key];
      const v = normalizeDraftValue(f, raw);
      if (v === undefined) {
        errors.push(`${def.name} → ${f.label}: "${String(raw)}" is not a valid ${f.type} (${where}).`);
      } else if (v === null && f.required) {
        errors.push(`${def.name} → ${f.label} is required (${where}).`);
      } else if (typeof v === "string" && f.type === "ref" && v.startsWith("new:") && !newIds.has(v)) {
        errors.push(`${def.name} → ${f.label} points at a new object that isn't in the draft (${where}).`);
      }
    }
  }
}

async function writeComponents(tx: Tx, entityId: string, comps: DraftComponent[], catalog: Map<string, ComponentDef>, refMap: Map<string, string>) {
  await tx`delete from component_instance where entity_id = ${entityId}`;
  let position = 0;
  for (const c of comps ?? []) {
    const def = catalog.get(c.component)!;
    const [inst] = await tx<{ id: string }[]>`
      insert into component_instance (entity_id, component_id, position) values (${entityId}, ${def.id}, ${position++}) returning id`;
    for (const f of def.fields) {
      let v: DraftValue | undefined = normalizeDraftValue(f, c.values?.[f.key]);
      if (v === undefined || v === null) continue;
      if (f.type === "ref") {
        v = refMap.get(v as string) ?? (v as string);
        await checkRefTarget(tx, v, f.options.component, def.name, f.label, entityId);
      }
      const s = toStored(f, v)!;
      await tx`
        insert into field_value (instance_id, field_id, value_text, value_number, value_date, value_bool, value_ref)
        values (${inst.id}, ${f.id}, ${s.value_text}, ${s.value_number}, ${s.value_date}::date, ${s.value_bool}, ${s.value_ref}::uuid)`;
    }
  }
}

async function checkRefTarget(tx: Tx, targetId: string, requiredComponent: string | undefined, compName: string, fieldLabel: string, selfId: string) {
  if (targetId === selfId) throw new HttpError(400, `${compName} → ${fieldLabel} can't point at itself.`);
  const [target] = await tx<{ id: string; ok: boolean }[]>`
    select e.id, ${requiredComponent ?? null}::text is null or exists (
      select 1 from component_instance ci join component_def cd on cd.id = ci.component_id
      where ci.entity_id = e.id and cd.key = ${requiredComponent ?? null}::text) as ok
    from entity e where e.id = ${targetId}`;
  if (!target) throw new HttpError(400, `${compName} → ${fieldLabel} points at something that no longer exists.`);
  if (!target.ok) throw new HttpError(400, `${compName} → ${fieldLabel} must point at something with the "${requiredComponent}" component.`);
}

export async function refTitles(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx<{ id: string; title: string }[]>`select id, title from entity where id = any(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.title]));
}

