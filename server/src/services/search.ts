import type { PendingQuery, Row } from "postgres";
import { sql } from "../db.js";
import { HttpError } from "../errors.js";
import type { DocumentStatus, DocumentSummary } from "../shared/types.js";
import { componentsByKey } from "./components.js";
import { normalizeDraftValue } from "./values.js";

export interface SearchParams {
  q?: string;
  status?: DocumentStatus[];
  /** documents must carry all of these component keys */
  components?: string[];
  /** documents must reference this entity in some ref field */
  ref?: string;
  /** "component.field:op:value", op one of eq, contains, gt, gte, lt, lte, empty, set */
  where?: string[];
  from?: string;
  to?: string;
  sort?: "relevance" | "date" | "added" | "title";
  limit?: number;
  offset?: number;
}

type Frag = PendingQuery<Row[]>;

const OPS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

export async function searchDocuments(p: SearchParams): Promise<{ total: number; items: DocumentSummary[] }> {
  const conds: Frag[] = [];
  const q = p.q?.trim();
  const tsq = q ? sql`websearch_to_tsquery('english', ${q})` : null;

  if (tsq) conds.push(sql`d.search @@ ${tsq}`);
  if (p.status?.length) conds.push(sql`d.status = any(${p.status}::text[])`);
  for (const key of p.components ?? []) {
    conds.push(sql`exists (select 1 from component_instance ci join component_def cd on cd.id = ci.component_id
                           where ci.entity_id = e.id and cd.key = ${key})`);
  }
  if (p.ref) {
    conds.push(sql`exists (select 1 from component_instance ci join field_value fv on fv.instance_id = ci.id
                           where ci.entity_id = e.id and fv.value_ref = ${p.ref}::uuid)`);
  }
  if (p.from) conds.push(sql`d.document_date >= ${p.from}::date`);
  if (p.to) conds.push(sql`d.document_date <= ${p.to}::date`);

  if (p.where?.length) {
    const catalog = await componentsByKey();
    for (const w of p.where) conds.push(fieldCondition(w, catalog));
  }

  const where = conds.length ? conds.reduce((a, c) => sql`${a} and ${c}`) : sql`true`;
  const order =
    p.sort === "relevance" && tsq ? sql`ts_rank(d.search, ${tsq}) desc, d.added_at desc` :
    p.sort === "title" ? sql`e.title asc` :
    p.sort === "added" ? sql`d.added_at desc` :
    sql`d.document_date desc nulls last, d.added_at desc`;
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const offset = Math.max(p.offset ?? 0, 0);

  const rows = await sql<(Omit<DocumentSummary, "components"> & { components: string[] | null; total: number })[]>`
    select e.id, e.title, d.status, d.original_filename as "originalFilename", d.mime_type as "mimeType",
           d.document_date as "documentDate", d.added_at as "addedAt", d.page_count as "pageCount",
           d.thumb_path is not null as "hasThumb", d.error,
           (select array_agg(cd.key order by ci.position) from component_instance ci join component_def cd on cd.id = ci.component_id
             where ci.entity_id = e.id) as components,
           ${tsq ? sql`ts_headline('english', left(d.content, 100000), ${tsq}, 'MaxFragments=2,MaxWords=18,MinWords=6,StartSel=<mark>,StopSel=</mark>')` : sql`null`} as snippet,
           count(*) over()::int as total
    from document d join entity e on e.id = d.entity_id
    where ${where}
    order by ${order}
    limit ${limit} offset ${offset}`;

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _t, ...r }) => ({ ...r, components: r.components ?? [], snippet: r.snippet ?? undefined })),
  };
}

function fieldCondition(expr: string, catalog: Awaited<ReturnType<typeof componentsByKey>>): Frag {
  const m = /^([a-z0-9_]+)\.([a-z0-9_]+):(eq|contains|gt|gte|lt|lte|empty|set)(?::(.*))?$/s.exec(expr);
  if (!m) throw new HttpError(400, `Bad filter "${expr}". Use component.field:op:value.`);
  const [, ck, fk, op, raw] = m;
  const field = catalog.get(ck)?.fields.find((f) => f.key === fk);
  if (!field) throw new HttpError(400, `Unknown field ${ck}.${fk}.`);

  const base = (cond: Frag) => sql`exists (
    select 1 from component_instance ci
    join component_def cd on cd.id = ci.component_id and cd.key = ${ck}
    join field_value fv on fv.instance_id = ci.id and fv.field_id = ${field.id}
    where ci.entity_id = e.id and ${cond})`;

  if (op === "set") return base(sql`true`);
  if (op === "empty") {
    return sql`not exists (
      select 1 from component_instance ci join component_def cd on cd.id = ci.component_id and cd.key = ${ck}
      join field_value fv on fv.instance_id = ci.id and fv.field_id = ${field.id}
      where ci.entity_id = e.id)`;
  }
  if (op === "contains") return base(sql`fv.value_text ilike ${"%" + (raw ?? "").replace(/[%_\\]/g, "\\$&") + "%"}`);

  const v = normalizeDraftValue(field, raw ?? "");
  if (v === undefined || v === null) throw new HttpError(400, `"${raw}" is not a valid ${field.type} for ${ck}.${fk}.`);
  const sqlOp = sql.unsafe(OPS[op]);
  switch (field.type) {
    case "number":
    case "money":
      return base(sql`fv.value_number ${sqlOp} ${v as number}`);
    case "date":
      return base(sql`fv.value_date ${sqlOp} ${v as string}::date`);
    case "boolean":
      return base(sql`fv.value_bool = ${v as boolean}`);
    case "ref":
      return base(sql`fv.value_ref = ${v as string}::uuid`);
    default:
      return base(sql`lower(fv.value_text) ${sqlOp} lower(${String(v)})`);
  }
}
