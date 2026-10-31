import type Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import type { AggregateSpec, AskResponse, ComponentDef, InterpretedSearch } from "../shared/types.ts";
import { anthropic, catalogJson, FALLBACK_BETA, objectsForPrompt } from "./ai.ts";
import { listComponents } from "./components.ts";
import { describeComponents, loadComponents, refTitles } from "./entities.ts";
import { semanticAvailable } from "./embeddings.ts";
import { aggregateDocuments, fieldCondition, searchDocuments, type SearchParams } from "./search.ts";
import { formatValue, isUuid, parseDate } from "./values.ts";

// ---------------------------------------------------------------------------
// Filters as the model expresses them, shared by "interpret" and the Ask tools.

const ConditionSchema = z.object({
  component: z.string(),
  field: z.string(),
  op: z.enum(["eq", "contains", "gt", "gte", "lt", "lte", "set", "empty"]),
  value: z.string().nullable().describe("Formatted like the field type: YYYY-MM-DD, plain numbers, true/false, an object id for links. Null for set/empty."),
});

const FilterShape = {
  text: z.string().nullable().describe("Words to look for in the documents' text and titles; null when the filters alone answer the question"),
  components: z.array(z.string()).describe("Component keys the documents must all carry"),
  conditions: z.array(ConditionSchema).describe("Conditions on field values"),
  object_id: z.string().nullable().describe("Only documents linked to this object (id from the object list)"),
  date_from: z.string().nullable().describe("Document date on or after, YYYY-MM-DD"),
  date_to: z.string().nullable().describe("Document date on or before, YYYY-MM-DD"),
};
type Filters = z.infer<z.ZodObject<typeof FilterShape>>;

const AggregateSchema = z.object({
  function: z.enum(["count", "sum", "avg", "min", "max"]),
  component: z.string().nullable().describe("For sum/avg/min/max: component of the number or money field"),
  field: z.string().nullable(),
  group_by: z.enum(["none", "year", "month", "object"]),
});

/** Turns model-supplied filters into SearchParams, dropping (and reporting) anything invalid. */
function toSearchParams(f: Filters, catalog: Map<string, ComponentDef>, objectIds: Set<string>, warnings: string[]): SearchParams {
  const components = f.components.filter((k) => {
    if (catalog.has(k)) return true;
    warnings.push(`Ignored unknown component "${k}".`);
    return false;
  });
  const where: string[] = [];
  for (const c of f.conditions) {
    const expr = ["set", "empty"].includes(c.op) ? `${c.component}.${c.field}:${c.op}` : `${c.component}.${c.field}:${c.op}:${c.value ?? ""}`;
    try {
      fieldCondition(expr, catalog); // validates; the fragment isn't run
      where.push(expr);
    } catch (err) {
      warnings.push(`Ignored a condition: ${(err as Error).message}`);
    }
  }
  let ref: string | undefined;
  if (f.object_id) {
    if (objectIds.has(f.object_id)) ref = f.object_id;
    else warnings.push("Ignored a link to an unknown object.");
  }
  const date = (s: string | null, what: string) => {
    if (!s) return undefined;
    const d = parseDate(s);
    if (!d) warnings.push(`Ignored ${what} "${s}".`);
    return d ?? undefined;
  };
  return {
    q: f.text?.trim() || undefined,
    components,
    where,
    ref,
    from: date(f.date_from, "start date"),
    to: date(f.date_to, "end date"),
  };
}

function toAggregateSpec(a: z.infer<typeof AggregateSchema>, catalog: Map<string, ComponentDef>, warnings: string[]): AggregateSpec | null {
  if (a.function === "count") return { fn: "count", groupBy: a.group_by };
  const field = a.component ? catalog.get(a.component)?.fields.find((f) => f.key === a.field) : undefined;
  if (!field || (field.type !== "number" && field.type !== "money")) {
    warnings.push(`Ignored a ${a.function} over ${a.component}.${a.field}: it isn't a number field.`);
    return null;
  }
  return { fn: a.function, component: a.component!, field: a.field!, groupBy: a.group_by };
}

async function context() {
  const components = await listComponents();
  const catalog = new Map(components.map((c) => [c.key, c]));
  const objects = await objectsForPrompt(catalog);
  return {
    catalog,
    objectIds: new Set(objects.map((o) => o.id)),
    // Stable across questions, so it's cached.
    block: {
      type: "text" as const,
      text: `Component catalog:\n${JSON.stringify(catalogJson(components), null, 2)}\n\nObjects:\n${JSON.stringify(objects, null, 2)}`,
      cache_control: { type: "ephemeral" as const },
    },
  };
}

const today = () => new Date().toISOString().slice(0, 10);

function checkStop(res: { stop_reason: string | null }) {
  if (res.stop_reason === "refusal") throw new HttpError(422, "The model declined this request.");
  if (res.stop_reason === "max_tokens") throw new HttpError(502, "The model's answer was cut off.");
}

// ---------------------------------------------------------------------------
// 1. Question -> structured search

const INTERPRET_PROMPT = `You translate questions about a personal document archive into a structured search.

The archive uses components (reusable groups of typed fields) attached to documents, and objects (cars, properties, accounts...) that documents link to. Use the catalog and object list below.

Prefer precise filters over text: "bills for the Civic" is the invoice component plus the Civic's object id, not the text "civic bills". Use text only for words that must appear in the document itself (a vendor not captured in a field, a topic). Interpret relative dates against today's date. When the question asks for an amount, count, average, or "how much", add an aggregate over the right number or money field; choose group_by when the question asks "per year", "by month", "for each car" and so on. Explain in one sentence what you searched for, in terms the owner will recognize.`;

const InterpretSchema = z.object({
  ...FilterShape,
  sort: z.enum(["relevance", "date", "added", "title"]),
  aggregate: AggregateSchema.nullable(),
  explanation: z.string(),
});

export async function interpretQuestion(question: string): Promise<InterpretedSearch> {
  const ctx = await context();
  const res = await anthropic().beta.messages.parse({
    model: config.ai.model,
    max_tokens: 4000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(InterpretSchema) },
    system: [{ type: "text", text: INTERPRET_PROMPT }, ctx.block],
    messages: [{ role: "user", content: `Today is ${today()}.\n\nQuestion: ${question}` }],
  });
  checkStop(res);
  const out = res.parsed_output;
  if (!out) throw new HttpError(502, "The model's answer did not match the expected format.");
  const warnings: string[] = [];
  const p = toSearchParams(out, ctx.catalog, ctx.objectIds, warnings);
  return {
    q: p.q ?? null,
    components: p.components ?? [],
    where: p.where ?? [],
    ref: p.ref ?? null,
    from: p.from ?? null,
    to: p.to ?? null,
    sort: out.sort === "relevance" && !p.q ? "date" : out.sort,
    aggregate: out.aggregate ? toAggregateSpec(out.aggregate, ctx.catalog, warnings) : null,
    explanation: out.explanation,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 3. Ask: an agent that searches, totals and reads documents, then answers with citations

const askPrompt = () => `You answer questions about the owner's personal document archive (bills, receipts, statements, contracts, letters) using the tools.

The archive uses components (reusable groups of typed fields) attached to documents, and objects (cars, properties, accounts...) that documents link to. The catalog and object list are below.

How to work:
- Search with precise filters where the catalog allows (component, field conditions, linked object, dates), and with text for topics and wording. Text search also matches by meaning${semanticAvailable() ? "" : " (currently words only)"}.
- Use the totals tool for sums, counts and averages instead of adding numbers up yourself.
- Read a document when the answer depends on details in its text (terms, coverage, line items). Search results show only metadata and a snippet.
- If something can't be found, say so plainly and mention what you tried. Never guess amounts, dates or terms.

Answer format:
- Plain text. Short paragraphs; "- " bullets for lists. No headings, no tables, no bold.
- Cite every document you rely on right after the fact it supports, as [[doc:<id>]] with the document id from the tools. Don't cite documents you didn't use.
- Give amounts with their currency and dates as YYYY-MM-DD.`;

const SearchToolInput = z.object({
  ...FilterShape,
  limit: z.number().int().describe("How many results, 1-30"),
});

const TotalsToolInput = z.object({ ...FilterShape, ...AggregateSchema.shape });

const ReadToolInput = z.object({
  id: z.string().describe("Document id"),
  offset: z.number().int().describe("Character offset into the text, 0 to start; use the offset a previous read returned to continue"),
});

const READ_CHARS = 12_000;

export async function askQuestion(question: string): Promise<AskResponse> {
  const ctx = await context();
  const steps: string[] = [];
  const seen = new Set<string>();

  const searchTool = betaZodTool({
    name: "search_documents",
    description: "Search documents by text/meaning and filters. Returns ids, titles, dates, component values and a snippet.",
    inputSchema: SearchToolInput,
    run: async (input) => {
      const warnings: string[] = [];
      const p = toSearchParams(input, ctx.catalog, ctx.objectIds, warnings);
      const res = await searchDocuments({ ...p, status: ["inbox", "filed"], sort: p.q ? "relevance" : "date", limit: Math.min(Math.max(input.limit, 1), 30) });
      steps.push(`Searched${p.q ? ` for "${p.q}"` : ""}${describeFilters(p, ctx.catalog)}: ${res.total} found`);
      const comps = await loadComponents(sql, res.items.map((i) => i.id));
      const refs = [...comps.values()].flatMap((cs) => cs.flatMap((c) => Object.values(c.values))).filter((v): v is string => typeof v === "string" && isUuid(v));
      const titles = await refTitles(sql, refs);
      res.items.forEach((i) => seen.add(i.id));
      return JSON.stringify({
        total: res.total,
        warnings,
        results: res.items.map((i) => ({
          id: i.id,
          title: i.title,
          date: i.documentDate,
          metadata: describeComponents(comps.get(i.id) ?? [], ctx.catalog, titles),
          matched: i.match,
          snippet: i.snippet?.replace(/<\/?mark>/g, ""),
        })),
      });
    },
  });

  const totalsTool = betaZodTool({
    name: "totals",
    description: "Count documents, or sum/average/min/max a number or money field, over documents matching the filters, optionally grouped by year, month or linked object. Text matching here is exact words only.",
    inputSchema: TotalsToolInput,
    run: async (input) => {
      const warnings: string[] = [];
      const p = toSearchParams(input, ctx.catalog, ctx.objectIds, warnings);
      const spec = toAggregateSpec(input, ctx.catalog, warnings);
      if (!spec) return JSON.stringify({ error: warnings.join(" ") });
      const r = await aggregateDocuments({ ...p, status: ["inbox", "filed"] }, spec);
      steps.push(`Calculated ${r.label.toLowerCase()}${describeFilters(p, ctx.catalog)}`);
      return JSON.stringify({ ...r, warnings });
    },
  });

  const readTool = betaZodTool({
    name: "read_document",
    description: `Read one document: its metadata, linked objects, and up to ${READ_CHARS} characters of its text starting at offset.`,
    inputSchema: ReadToolInput,
    run: async ({ id, offset }) => {
      if (!isUuid(id)) return JSON.stringify({ error: "Not a document id." });
      const [d] = await sql<{ title: string; document_date: string | null; content: string; original_filename: string }[]>`
        select e.title, d.document_date, d.content, d.original_filename
        from document d join entity e on e.id = d.entity_id where e.id = ${id}`;
      if (!d) return JSON.stringify({ error: "No document with that id." });
      seen.add(id);
      steps.push(`Read "${d.title}"`);
      const comps = (await loadComponents(sql, [id])).get(id) ?? [];
      const refs = comps.flatMap((c) => Object.values(c.values)).filter((v): v is string => typeof v === "string" && isUuid(v));
      const titles = await refTitles(sql, refs);
      const start = Math.max(0, offset);
      const text = d.content.slice(start, start + READ_CHARS);
      const next = start + READ_CHARS < d.content.length ? start + READ_CHARS : null;
      return JSON.stringify({
        id,
        title: d.title,
        date: d.document_date,
        filename: d.original_filename,
        components: comps.map((c) => {
          const def = ctx.catalog.get(c.component);
          return {
            component: def?.name ?? c.component,
            values: Object.fromEntries(
              Object.entries(c.values).map(([k, v]) => {
                const f = def?.fields.find((x) => x.key === k);
                return [f?.label ?? k, f ? formatValue(f, v, titles) : v];
              }),
            ),
          };
        }),
        text,
        ...(next !== null ? { more_text_from_offset: next, total_chars: d.content.length } : {}),
      });
    },
  });

  const final = await anthropic().beta.messages.toolRunner({
    model: config.ai.model,
    max_tokens: 16000,
    max_iterations: config.ai.askMaxSteps,
    // Resend the (short) history each turn instead of keeping a server-side
    // thread, so document text isn't stored with the API between turns.
    thread: false,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: config.ai.effort },
    system: [{ type: "text", text: askPrompt() }, ctx.block],
    tools: [searchTool, totalsTool, readTool],
    messages: [{ role: "user", content: `Today is ${today()}.\n\n${question}` }],
  });

  checkStop(final);
  let answer = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (final.stop_reason === "tool_use") {
    answer = `${answer ? answer + "\n\n" : ""}I ran out of lookups (${config.ai.askMaxSteps}) before finishing. Try a narrower question.`;
  }

  // Keep only citations of documents the tools actually returned.
  const cited: string[] = [];
  answer = answer.replace(/\[\[doc:([0-9a-f-]{36})\]\]/gi, (m, id: string) => {
    if (!seen.has(id)) return "";
    if (!cited.includes(id)) cited.push(id);
    return m;
  });
  const rows = cited.length
    ? await sql<{ id: string; title: string; document_date: string | null }[]>`
        select e.id, e.title, d.document_date from entity e join document d on d.entity_id = e.id where e.id = any(${cited}::uuid[])`
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    answer,
    citations: cited.filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id)!.title, documentDate: byId.get(id)!.document_date })),
    steps,
  };
}

function describeFilters(p: SearchParams, catalog: Map<string, ComponentDef>): string {
  const parts: string[] = [];
  if (p.components?.length) parts.push(p.components.map((k) => catalog.get(k)?.name ?? k).join(" + "));
  if (p.where?.length) parts.push(p.where.join(", "));
  if (p.from || p.to) parts.push(`${p.from ?? "…"} to ${p.to ?? "…"}`);
  if (p.ref) parts.push("linked object");
  return parts.length ? ` (${parts.join("; ")})` : "";
}

