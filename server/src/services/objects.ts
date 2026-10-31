import type { Tx } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { ComponentDef, Draft, DraftComponent, DraftObjectUpdate, DraftValue } from "../shared/types.ts";
import { componentsByKey } from "./components.ts";
import { loadComponents } from "./entities.ts";
import { formatValue, isUuid, normalizeIdentifier } from "./values.ts";

export { normalizeIdentifier };

/**
 * Keeps objects (cars, houses, accounts…) from being duplicated, and merges
 * them when they were.
 *
 * Two objects are the same when they carry the same component with the same
 * value in an identifier field (VIN, licence plate, account number…).
 * Values are compared normalised, so "JRO 686" and "jro-686" match.
 */

const isEmpty = (v: DraftValue | undefined) => v === null || v === undefined || v === "";

interface Match {
  id: string;
  title: string;
  /** e.g. "same VIN JM1BPAML5N1518380" */
  reason: string;
}

/** Finds an existing object sharing an identifier value with these components. */
export async function findObjectByIdentifiers(tx: Tx, comps: DraftComponent[], catalog: Map<string, ComponentDef>): Promise<Match | null> {
  for (const c of comps) {
    const def = catalog.get(c.component);
    if (!def) continue;
    for (const f of def.fields.filter((x) => x.options.identifier)) {
      const norm = normalizeIdentifier(c.values[f.key] ?? null);
      if (!norm) continue;
      // Oldest first: if duplicates already exist, prefer the original.
      const [row] = await tx<{ id: string; title: string }[]>`
        select e.id, e.title
        from component_instance ci
        join entity e on e.id = ci.entity_id and e.kind = 'object'
        join field_value fv on fv.instance_id = ci.id and fv.field_id = ${f.id}
        where ci.component_id = ${def.id}
          and upper(regexp_replace(coalesce(fv.value_text, fv.value_number::text, ''), '[^a-zA-Z0-9]', '', 'g')) = ${norm}
        order by e.created_at
        limit 1`;
      if (row) return { ...row, reason: `same ${f.label} ${String(c.values[f.key])}` };
    }
  }
  return null;
}

/** Follows merge redirects, so ids of merged-away objects point at the survivor. */
async function redirects(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const uuids = [...new Set(ids.filter(isUuid))];
  if (!uuids.length) return new Map();
  const rows = await tx<{ old_id: string; new_id: string }[]>`select old_id, new_id from object_redirect where old_id = any(${uuids}::uuid[])`;
  return new Map(rows.map((r) => [r.old_id, r.new_id]));
}

function mapRefs(comps: DraftComponent[], map: Map<string, string>): DraftComponent[] {
  return comps.map((c) => ({
    ...c,
    values: Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, typeof v === "string" && map.has(v) ? map.get(v)! : v])),
  }));
}

/** Adds component values to an object's pending update, merging per component. */
function addUpdate(updates: DraftObjectUpdate[], objectId: string, comps: DraftComponent[]) {
  let u = updates.find((x) => x.objectId === objectId);
  if (!u) {
    u = { objectId, components: [] };
    updates.push(u);
  }
  for (const c of comps) {
    const existing = u.components.find((x) => x.component === c.component);
    if (existing) Object.assign(existing.values, c.values);
    else u.components.push({ component: c.component, values: { ...c.values } });
  }
}

/**
 * Turns proposed new objects that already exist into links to the existing
 * object, plus updates that fill in details it doesn't have yet. Values that
 * conflict with what the existing object says are left alone and noted.
 *
 * `sameAs` forces a match chosen by the owner (tempId -> object id).
 * Also follows merge redirects for every object id in the draft.
 */
export async function reconcileDraft(tx: Tx, input: Draft, sameAs: Record<string, string> = {}): Promise<{ draft: Draft; notes: string[] }> {
  const draft: Draft = structuredClone({ ...input, objectUpdates: input.objectUpdates ?? [] });
  const catalog = await componentsByKey(tx);
  const notes: string[] = [];

  // Ids of objects merged since the draft was written.
  const allRefs = [
    ...draft.components.flatMap((c) => Object.values(c.values)),
    ...draft.newObjects.flatMap((o) => o.components.flatMap((c) => Object.values(c.values))),
    ...draft.objectUpdates!.flatMap((u) => [u.objectId, ...u.components.flatMap((c) => Object.values(c.values))]),
  ].filter((v): v is string => typeof v === "string");
  const moved = await redirects(tx, [...allRefs, ...Object.values(sameAs)]);

  const refMap = new Map(moved);
  const keep: Draft["newObjects"] = [];
  for (const o of draft.newObjects) {
    let match: Match | null = null;
    const forced = sameAs[o.tempId] ? moved.get(sameAs[o.tempId]) ?? sameAs[o.tempId] : null;
    if (forced) {
      const [row] = await tx<{ id: string; title: string }[]>`select id, title from entity where id = ${forced} and kind = 'object'`;
      if (!row) throw new HttpError(400, "That object no longer exists.");
      match = { ...row, reason: "chosen by you" };
    } else {
      match = await findObjectByIdentifiers(tx, o.components, catalog);
    }
    if (!match) {
      keep.push(o);
      continue;
    }
    refMap.set(`new:${o.tempId}`, match.id);

    // What the proposed object knows that the existing one doesn't.
    const existing = (await loadComponents(tx, [match.id])).get(match.id) ?? [];
    const fills: DraftComponent[] = [];
    const added: string[] = [];
    const conflicts: string[] = [];
    for (const c of o.components) {
      const def = catalog.get(c.component);
      const have = existing.find((x) => x.component === c.component);
      const values: DraftComponent["values"] = {};
      for (const [k, v] of Object.entries(c.values)) {
        if (isEmpty(v)) continue;
        const field = def?.fields.find((f) => f.key === k);
        const label = field?.label ?? k;
        const current = have?.values[k];
        if (isEmpty(current)) {
          values[k] = v;
          added.push(`${label} ${field ? formatValue(field, v) : String(v)}`);
        } else if (normalizeIdentifier(current!) !== normalizeIdentifier(v) && String(current) !== String(v)) {
          conflicts.push(`${label} (has "${String(current)}", this document says "${String(v)}")`);
        }
      }
      if (Object.keys(values).length) fills.push({ component: c.component, values });
    }
    if (fills.length) addUpdate(draft.objectUpdates!, match.id, fills);
    notes.push(
      `"${o.title}" is the existing object "${match.title}" (${match.reason})` +
        (added.length ? `; adds ${added.join(", ")}` : "") +
        (conflicts.length ? `; kept its existing ${conflicts.join(", ")}` : "") +
        ".",
    );
  }

  draft.newObjects = keep.map((o) => ({ ...o, components: mapRefs(o.components, refMap) }));
  draft.components = mapRefs(draft.components, refMap);
  // Updates for the same object (after redirects) are combined.
  const updates: DraftObjectUpdate[] = [];
  for (const u of draft.objectUpdates!) addUpdate(updates, refMap.get(u.objectId) ?? u.objectId, mapRefs(u.components, refMap));
  draft.objectUpdates = updates;
  return { draft, notes };
}

/**
 * Merges `sourceId` into `targetId`: every link to the source now points at
 * the target, components and values the target lacks move over, and the
 * source is deleted. Where both have a value, the target's is kept.
 */
export async function mergeObjects(tx: Tx, sourceId: string, targetId: string): Promise<{ kept: string[]; discarded: string[] }> {
  if (sourceId === targetId) throw new HttpError(400, "Can't merge an object into itself.");
  const objs = await tx<{ id: string; title: string; notes: string }[]>`
    select id, title, notes from entity where id = any(${[sourceId, targetId]}::uuid[]) and kind = 'object' for update`;
  const source = objs.find((o) => o.id === sourceId);
  const target = objs.find((o) => o.id === targetId);
  if (!source || !target) throw new HttpError(404, "Object not found.");

  const catalog = await componentsByKey(tx);
  const byId = new Map([...catalog.values()].map((c) => [c.id, c]));
  const discarded: string[] = [];

  // Links from the target to the source would become self-links; clear them.
  await tx`
    update field_value fv set value_ref = null
    from component_instance ci where ci.id = fv.instance_id and ci.entity_id = ${targetId} and fv.value_ref = ${sourceId}`;
  await tx`update field_value set value_ref = ${targetId} where value_ref = ${sourceId}`;

  const sourceInstances = await tx<{ id: string; component_id: string }[]>`
    select id, component_id from component_instance where entity_id = ${sourceId} order by position`;
  const targetInstances = await tx<{ id: string; component_id: string }[]>`
    select id, component_id from component_instance where entity_id = ${targetId} order by position`;
  let position = targetInstances.length;
  for (const si of sourceInstances) {
    const ti = targetInstances.find((t) => t.component_id === si.component_id);
    if (!ti) {
      await tx`update component_instance set entity_id = ${targetId}, position = ${position++} where id = ${si.id}`;
      continue;
    }
    // Same component on both: move over the values the target doesn't have.
    const moved = await tx<{ field_id: string }[]>`
      update field_value fv set instance_id = ${ti.id}
      where fv.instance_id = ${si.id}
        and not exists (select 1 from field_value t where t.instance_id = ${ti.id} and t.field_id = fv.field_id)
      returning fv.field_id`;
    // Values both had: the target's wins. Report only the ones that differed.
    const left = await tx<{ field_id: string; mine: string | null; theirs: string | null }[]>`
      select s.field_id,
        coalesce(s.value_text, s.value_number::text, s.value_date::text, s.value_bool::text, s.value_ref::text) as mine,
        coalesce(t.value_text, t.value_number::text, t.value_date::text, t.value_bool::text, t.value_ref::text) as theirs
      from field_value s left join field_value t on t.instance_id = ${ti.id} and t.field_id = s.field_id
      where s.instance_id = ${si.id}`;
    const def = byId.get(si.component_id);
    for (const l of left) {
      const f = def?.fields.find((x) => x.id === l.field_id);
      if (f && l.mine !== null && normalizeIdentifier(l.mine) !== normalizeIdentifier(l.theirs)) {
        discarded.push(`${def!.name} › ${f.label}: ${l.mine}`);
      }
    }
    void moved;
    await tx`delete from component_instance where id = ${si.id}`;
  }

  if (source.notes.trim()) {
    await tx`update entity set notes = ${[target.notes.trim(), `From "${source.title}":\n${source.notes.trim()}`].filter(Boolean).join("\n\n")} where id = ${targetId}`;
  }
  await tx`update object_redirect set new_id = ${targetId} where new_id = ${sourceId}`;
  await tx`
    insert into object_redirect (old_id, new_id) values (${sourceId}, ${targetId})
    on conflict (old_id) do update set new_id = excluded.new_id`;
  await tx`delete from entity where id = ${sourceId}`;
  await tx`update entity set updated_at = now() where id = ${targetId}`;

  const docs = await tx<{ entity_id: string }[]>`
    select distinct ci.entity_id from field_value fv join component_instance ci on ci.id = fv.instance_id
    join document d on d.entity_id = ci.entity_id where fv.value_ref = ${targetId}`;
  for (const d of docs) await tx`select refresh_document_search(${d.entity_id})`;
  return { kept: [target.title], discarded };
}

const tokens = (title: string) => new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);

/**
 * Groups of objects that look like the same thing: a shared identifier value
 * (certain), or titles where one's words are almost all in the other's and
 * the objects share a component (likely; review before merging).
 */
export async function findDuplicates(tx: Tx): Promise<Array<{ ids: string[]; reason: string; certain: boolean }>> {
  const objects = await tx<{ id: string; title: string }[]>`select id, title from entity where kind = 'object' order by created_at`;
  const comps = await loadComponents(tx, objects.map((o) => o.id));
  const catalog = await componentsByKey(tx);

  const parent = new Map(objects.map((o) => [o.id, o.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  const reasons = new Map<string, { text: string; certain: boolean }>();
  const union = (a: string, b: string, text: string, certain: boolean) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    parent.set(rb, ra);
    const prev = reasons.get(ra) ?? reasons.get(rb);
    reasons.set(ra, prev && (prev.certain || !certain) ? prev : { text, certain });
  };

  // Certain: same component, same identifier value.
  const seen = new Map<string, { id: string; label: string; value: string }>();
  for (const o of objects) {
    for (const c of comps.get(o.id) ?? []) {
      const def = catalog.get(c.component);
      for (const f of def?.fields.filter((x) => x.options.identifier) ?? []) {
        const norm = normalizeIdentifier(c.values[f.key] ?? null);
        if (!norm) continue;
        const key = `${c.component}|${f.key}|${norm}`;
        const first = seen.get(key);
        if (first) union(first.id, o.id, `same ${f.label} ${String(c.values[f.key])}`, true);
        else seen.set(key, { id: o.id, label: f.label, value: norm });
      }
    }
  }
  // Likely: one title's words nearly all appear in the other's, and they share a component.
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const [a, b] = [objects[i], objects[j]];
      const ca = new Set((comps.get(a.id) ?? []).map((c) => c.component));
      if (!(comps.get(b.id) ?? []).some((c) => ca.has(c.component))) continue;
      const [ta, tb] = [tokens(a.title), tokens(b.title)];
      const shared = [...ta].filter((t) => tb.has(t)).length;
      const smaller = Math.min(ta.size, tb.size);
      if (smaller >= 2 && shared / smaller >= 0.8) union(a.id, b.id, "similar names", false);
    }
  }

  const groups = new Map<string, string[]>();
  for (const o of objects) groups.set(find(o.id), [...(groups.get(find(o.id)) ?? []), o.id]);
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([root, ids]) => ({ ids, reason: reasons.get(root)?.text ?? "similar", certain: reasons.get(root)?.certain ?? false }));
}
