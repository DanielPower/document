import { sql, type Tx } from "../db.ts";
import { FIELD_TYPES, type ComponentDef, type ComponentInput, type FieldDef } from "../shared/types.ts";
import { HttpError } from "../errors.ts";

const KEY_RE = /^[a-z][a-z0-9_]*$/;

interface ComponentRow {
  id: string;
  key: string;
  name: string;
  description: string;
  ai_hint: string;
  color: string;
  usage: number;
  fields: FieldDef[] | null;
}

export async function listComponents(tx: Tx = sql): Promise<ComponentDef[]> {
  const rows = await tx<ComponentRow[]>`
    select c.id, c.key, c.name, c.description, c.ai_hint, c.color,
      (select count(*)::int from component_instance ci where ci.component_id = c.id) as usage,
      (select json_agg(json_build_object(
          'id', f.id, 'key', f.key, 'label', f.label, 'type', f.type, 'description', f.description,
          'required', f.required, 'options', f.options, 'position', f.position) order by f.position, f.key)
        from field_def f where f.component_id = c.id) as fields
    from component_def c
    order by c.name`;
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    aiHint: r.ai_hint,
    color: r.color,
    usage: r.usage,
    fields: r.fields ?? [],
  }));
}

export async function componentsByKey(tx: Tx = sql): Promise<Map<string, ComponentDef>> {
  return new Map((await listComponents(tx)).map((c) => [c.key, c]));
}

export function validateComponentInput(input: ComponentInput): string[] {
  const errors: string[] = [];
  if (!KEY_RE.test(input.key)) errors.push(`Component key "${input.key}" must be snake_case (a-z, 0-9, _).`);
  if (!input.name?.trim()) errors.push(`Component "${input.key}" needs a name.`);
  const seen = new Set<string>();
  for (const f of input.fields) {
    if (!KEY_RE.test(f.key)) errors.push(`Field key "${f.key}" in "${input.key}" must be snake_case.`);
    if (seen.has(f.key)) errors.push(`Field key "${f.key}" appears twice in "${input.key}".`);
    seen.add(f.key);
    if (!FIELD_TYPES.includes(f.type)) errors.push(`Field "${f.key}" has unknown type "${f.type}".`);
    if (f.type === "select" && !(f.options?.choices?.length)) errors.push(`Select field "${f.key}" needs at least one choice.`);
  }
  return errors;
}

function cleanOptions(f: ComponentInput["fields"][number]) {
  const o = f.options ?? {};
  if (f.type === "select") return { choices: (o.choices ?? []).map((c) => c.trim()).filter(Boolean) };
  if (f.type === "money") return o.currency ? { currency: o.currency.toUpperCase() } : {};
  if (f.type === "ref") return o.component ? { component: o.component } : {};
  return {};
}

export async function createComponent(tx: Tx, input: ComponentInput): Promise<string> {
  const errors = validateComponentInput(input);
  if (errors.length) throw new HttpError(400, errors.join(" "));
  const [existing] = await tx`select id from component_def where key = ${input.key}`;
  if (existing) throw new HttpError(409, `A component with key "${input.key}" already exists.`);
  const [row] = await tx<{ id: string }[]>`
    insert into component_def (key, name, description, ai_hint, color)
    values (${input.key}, ${input.name.trim()}, ${input.description ?? ""}, ${input.aiHint ?? ""}, ${input.color ?? randomColor()})
    returning id`;
  let position = 0;
  for (const f of input.fields) {
    await tx`
      insert into field_def (component_id, key, label, type, description, required, options, position)
      values (${row.id}, ${f.key}, ${f.label || f.key}, ${f.type}, ${f.description ?? ""}, ${!!f.required},
              ${tx.json(cleanOptions(f))}, ${position++})`;
  }
  return row.id;
}

export async function updateComponent(tx: Tx, id: string, input: ComponentInput): Promise<void> {
  const errors = validateComponentInput(input);
  if (errors.length) throw new HttpError(400, errors.join(" "));
  const [current] = await tx<{ key: string }[]>`select key from component_def where id = ${id} for update`;
  if (!current) throw new HttpError(404, "Component not found.");
  if (current.key !== input.key) {
    const [clash] = await tx`select id from component_def where key = ${input.key} and id <> ${id}`;
    if (clash) throw new HttpError(409, `A component with key "${input.key}" already exists.`);
  }
  await tx`
    update component_def set key = ${input.key}, name = ${input.name.trim()}, description = ${input.description ?? ""},
      ai_hint = ${input.aiHint ?? ""}, color = ${input.color ?? "#6b7280"}, updated_at = now()
    where id = ${id}`;

  const existing = await tx<{ id: string; type: string }[]>`select id, type from field_def where component_id = ${id}`;
  const existingById = new Map(existing.map((f) => [f.id, f]));
  const keep = new Set(input.fields.filter((f) => f.id).map((f) => f.id!));
  // Removing a field deletes its values (cascade). Temporarily move keys out of the way so renames/swaps don't clash.
  await tx`delete from field_def where component_id = ${id} and not (id = any(${[...keep]}::uuid[]))`;
  await tx`update field_def set key = '_tmp_' || replace(id::text, '-', '') where component_id = ${id}`;

  let position = 0;
  for (const f of input.fields) {
    const options = tx.json(cleanOptions(f));
    if (f.id && existingById.has(f.id)) {
      const old = existingById.get(f.id)!;
      if (old.type !== f.type) {
        // Type changed: stored values in the old typed column no longer apply.
        await tx`delete from field_value where field_id = ${f.id}`;
      }
      await tx`
        update field_def set key = ${f.key}, label = ${f.label || f.key}, type = ${f.type}, description = ${f.description ?? ""},
          required = ${!!f.required}, options = ${options}, position = ${position++}
        where id = ${f.id}`;
    } else {
      await tx`
        insert into field_def (component_id, key, label, type, description, required, options, position)
        values (${id}, ${f.key}, ${f.label || f.key}, ${f.type}, ${f.description ?? ""}, ${!!f.required}, ${options}, ${position++})`;
    }
  }
}

export async function deleteComponent(tx: Tx, id: string, force: boolean): Promise<void> {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from component_instance where component_id = ${id}`;
  if (n > 0 && !force) {
    throw new HttpError(409, `This component is attached to ${n} item(s). Delete anyway to remove it from all of them.`);
  }
  const affected = await tx<{ entity_id: string }[]>`
    delete from component_instance where component_id = ${id} returning entity_id`;
  await tx`delete from component_def where id = ${id}`;
  for (const { entity_id } of affected) await tx`select refresh_document_search(${entity_id})`;
}

function randomColor(): string {
  const palette = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#059669"];
  return palette[Math.floor(Math.random() * palette.length)];
}
