import type { PendingQuery, Row } from "postgres";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { AggregateResult, AggregateSpec, DocumentStatus, DocumentSummary } from "../shared/types.ts";
import { componentsByKey } from "./components.ts";
import { embedQuery, semanticAvailable, toVectorLiteral } from "./embeddings.ts";
import { normalizeDraftValue } from "./values.ts";

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
  /** Also match by meaning (embeddings) when semantic search is available. Default true. */
  semantic?: boolean;
  limit?: number;
  offset?: number;
}

type Frag = PendingQuery<Row[]>;

const OPS: Record<string, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** Reciprocal-rank-fusion constant: how much the top ranks dominate when blending. */
const RRF_K = 60;

/**
 * Every filter except the text query. Expects `d` (document) and `e` (entity) in scope.
 * Wrapped in an object: a fragment is "thenable", so awaiting one directly would run it.
 */
async function filterConditions(p: SearchParams): Promise<{ where: Frag }> {
  const conds: Frag[] = [];
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
  return { where: conds.length ? conds.reduce((a, c) => sql`${a} and ${c}`) : sql`true` };
}

const SUMMARY_COLUMNS = sql`
  e.id, e.title, d.status, d.original_filename as "originalFilename", d.mime_type as "mimeType",
  d.document_date as "documentDate", d.added_at as "addedAt", d.page_count as "pageCount",
  d.thumb_path is not null as "hasThumb", d.error,
  (select array_agg(cd.key order by ci.position) from component_instance ci join component_def cd on cd.id = ci.component_id
    where ci.entity_id = e.id) as components,
  case when d.status = 'inbox' and d.proposal is not null then jsonb_build_object(
    'title', d.proposal->'draft'->>'title',
    'documentDate', d.proposal->'draft'->>'documentDate',
    'components', coalesce((select jsonb_agg(x->>'component') from jsonb_array_elements(d.proposal->'draft'->'components') x), '[]'::jsonb)
  ) end as proposed`;

type Row_ = Omit<DocumentSummary, "components" | "proposed"> & { components: string[] | null; proposed: DocumentSummary["proposed"] | null; total: number; chunk?: string | null; text_hit?: boolean; meaning_hit?: boolean };

const headline = (tsq: Frag) =>
  sql`ts_headline('english', left(d.content, 100000), ${tsq}, 'MaxFragments=2,MaxWords=18,MinWords=6,StartSel=<mark>,StopSel=</mark>')`;

/**
 * Searches documents. With a text query, results come from full-text search
 * and, when semantic search is available, from embedding similarity; the two
 * rankings are blended with reciprocal rank fusion.
 */
export async function searchDocuments(p: SearchParams): Promise<{ total: number; items: DocumentSummary[]; semantic: boolean }> {
  const { where: filters } = await filterConditions(p);
  const q = p.q?.trim();
  const tsq = q ? sql`websearch_to_tsquery('english', ${q})` : null;
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const offset = Math.max(p.offset ?? 0, 0);
  const order = (relevance: Frag) =>
    p.sort === "relevance" && q ? relevance :
    p.sort === "title" ? sql`e.title asc` :
    p.sort === "added" ? sql`d.added_at desc` :
    sql`d.document_date desc nulls last, d.added_at desc`;

  let qvec: string | null = null;
  if (q && p.semantic !== false && semanticAvailable()) {
    try {
      qvec = toVectorLiteral(await embedQuery(q));
    } catch {
      // Embeddings API unavailable right now: fall back to text search.
    }
  }

  let rows: Row_[];
  if (!tsq) {
    rows = await sql<Row_[]>`
      select ${SUMMARY_COLUMNS}, null as snippet, count(*) over()::int as total
      from document d join entity e on e.id = d.entity_id
      where ${filters}
      order by ${order(sql`d.added_at desc`)}
      limit ${limit} offset ${offset}`;
  } else if (!qvec) {
    rows = await sql<Row_[]>`
      select ${SUMMARY_COLUMNS}, ${headline(tsq)} as snippet, true as text_hit, count(*) over()::int as total
      from document d join entity e on e.id = d.entity_id
      where ${filters} and d.search @@ ${tsq}
      order by ${order(sql`ts_rank(d.search, ${tsq}) desc, d.added_at desc`)}
      limit ${limit} offset ${offset}`;
  } else {
    const v = sql`${qvec}::vector`;
    rows = await sql<Row_[]>`
      with ft as (
        select d.entity_id, row_number() over (order by ts_rank(d.search, ${tsq}) desc) as r
        from document d join entity e on e.id = d.entity_id
        where ${filters} and d.search @@ ${tsq}
        limit 500
      ), best as (
        select distinct on (c.entity_id) c.entity_id, c.content, 1 - (c.embedding <=> ${v}) as sim
        from document_chunk c join document d on d.entity_id = c.entity_id join entity e on e.id = c.entity_id
        where ${filters}
        order by c.entity_id, c.embedding <=> ${v}
      ), vs as (
        select entity_id, content, row_number() over (order by sim desc) as r
        from best
        where sim >= ${config.embeddings.minSimilarity}
          and sim >= (select max(sim) from best) - ${config.embeddings.margin}
        order by sim desc
        limit 50
      ), hits as (
        select coalesce(ft.entity_id, vs.entity_id) as entity_id,
               coalesce(1.0 / (${RRF_K} + ft.r), 0) + coalesce(1.0 / (${RRF_K} + vs.r), 0) as score,
               ft.entity_id is not null as text_hit, vs.entity_id is not null as meaning_hit, vs.content as chunk
        from ft full join vs on vs.entity_id = ft.entity_id
      )
      select ${SUMMARY_COLUMNS},
             case when h.text_hit then ${headline(tsq)} end as snippet,
             h.chunk, h.text_hit, h.meaning_hit, count(*) over()::int as total
      from hits h join document d on d.entity_id = h.entity_id join entity e on e.id = h.entity_id
      order by ${order(sql`h.score desc, d.added_at desc`)}
      limit ${limit} offset ${offset}`;
  }

  return {
    total: rows[0]?.total ?? 0,
    semantic: !!qvec,
    items: rows.map(({ total: _t, chunk, text_hit, meaning_hit, ...r }) => ({
      ...r,
      components: r.components ?? [],
      proposed: r.proposed ?? undefined,
      snippet: r.snippet ?? (chunk ? excerpt(chunk) : undefined),
      match: text_hit && meaning_hit ? "both" : text_hit ? "text" : meaning_hit ? "meaning" : undefined,
    })),
  };
}

function excerpt(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 240 ? t.slice(0, 237) + "..." : t;
}

/**
 * Totals over the documents matching the filters, e.g. the sum of Invoice ›
 * Total per year. The text query uses exact full-text matching only, so a
 * total never silently includes loosely related documents.
 */
export async function aggregateDocuments(p: SearchParams, a: AggregateSpec): Promise<AggregateResult> {
  const { where: filters } = await filterConditions(p);
  const q = p.q?.trim();
  const textCond = q ? sql`and d.search @@ websearch_to_tsquery('english', ${q})` : sql``;

  let valueJoin = sql``;
  let valueExpr: Frag;
  let label = "Documents";
  let unit: string | null = null;
  if (a.fn === "count") {
    valueExpr = sql`count(distinct d.entity_id)::float8`;
  } else {
    const catalog = await componentsByKey();
    const comp = a.component ? catalog.get(a.component) : undefined;
    const field = comp?.fields.find((f) => f.key === a.field);
    if (!comp || !field) throw new HttpError(400, `Unknown field ${a.component}.${a.field}.`);
    if (field.type !== "number" && field.type !== "money") {
      throw new HttpError(400, `${comp.name} › ${field.label} is not a number, so it can't be totalled.`);
    }
    valueJoin = sql`
      join component_instance ai on ai.entity_id = e.id and ai.component_id = ${comp.id}
      join field_value afv on afv.instance_id = ai.id and afv.field_id = ${field.id} and afv.value_number is not null`;
    const fn = { sum: sql`sum`, avg: sql`avg`, min: sql`min`, max: sql`max` }[a.fn];
    valueExpr = sql`${fn}(afv.value_number)::float8`;
    label = `${{ sum: "Sum", avg: "Average", min: "Lowest", max: "Highest" }[a.fn]} of ${comp.name} › ${field.label}`;
    unit = field.type === "money" ? field.options.currency ?? null : null;
  }

  let groupJoin = sql``;
  let groupExpr = sql`null::text`;
  let groupOrder = sql`1`;
  if (a.groupBy === "year") {
    groupExpr = sql`extract(year from d.document_date)::int::text`;
    groupOrder = sql`grp asc nulls last`;
  } else if (a.groupBy === "month") {
    groupExpr = sql`to_char(d.document_date, 'YYYY-MM')`;
    groupOrder = sql`grp asc nulls last`;
  } else if (a.groupBy === "object") {
    // A document linked to several objects counts once in each group.
    groupJoin = sql`
      left join lateral (
        select distinct fv2.value_ref as obj from component_instance ci2
        join field_value fv2 on fv2.instance_id = ci2.id
        where ci2.entity_id = e.id and fv2.value_ref is not null) l on true
      left join entity oe on oe.id = l.obj and oe.kind = 'object'`;
    groupExpr = sql`oe.title`;
    groupOrder = sql`value desc nulls last`;
  }

  const rows = await sql<{ grp: string | null; value: number | null; documents: number }[]>`
    select ${groupExpr} as grp, ${valueExpr} as value, count(distinct d.entity_id)::int as documents
    from document d join entity e on e.id = d.entity_id
    ${valueJoin}
    ${groupJoin}
    where ${filters} ${textCond}
    group by 1
    order by ${groupOrder}`;

  return {
    label,
    unit,
    groupBy: a.groupBy,
    rows: rows.map((r) => ({ group: r.grp, value: r.value === null ? null : Math.round(r.value * 100) / 100, documents: r.documents })),
  };
}

export function fieldCondition(expr: string, catalog: Awaited<ReturnType<typeof componentsByKey>>): Frag {
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
