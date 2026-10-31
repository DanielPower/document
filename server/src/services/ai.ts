import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import {
  FIELD_TYPES,
  type ComponentDef,
  type ComponentInput,
  type Draft,
  type DraftComponent,
  type FieldDef,
  type Proposal,
} from "../shared/types.ts";
import { listComponents, validateComponentInput } from "./components.ts";
import { describeComponents, loadComponents, refTitles } from "./entities.ts";
import { isUuid, normalizeDraftValue, parseDate } from "./values.ts";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Credentials come from ANTHROPIC_API_KEY (or the other standard SDK sources).
  client ??= new Anthropic();
  return client;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

// ---------------------------------------------------------------------------
// Output schemas. Values are strings so one static schema works for every
// component; the server converts them to each field's type afterwards.

const ValueSchema = z.object({
  field: z.string().describe("Field key"),
  value: z.string().describe("Value as text. See the value-format rules."),
});

const ComponentSchema = z.object({
  component: z.string().describe("Component key: an existing one, or one from new_components"),
  values: z.array(ValueSchema),
});

const NewFieldSchema = z.object({
  key: z.string().describe("snake_case"),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  description: z.string(),
  required: z.boolean(),
  choices: z.array(z.string()).describe("Only for type select; otherwise empty"),
  currency: z.string().nullable().describe("Only for type money, e.g. CAD; otherwise null"),
  ref_component: z.string().nullable().describe("Only for type ref: component key the target object must have, or null"),
});

const NewComponentSchema = z.object({
  key: z.string().describe("snake_case, unique"),
  name: z.string(),
  description: z.string(),
  ai_hint: z.string().describe("When this component should be attached, written for a future classifier"),
  fields: z.array(NewFieldSchema),
});

export const AnalysisSchema = z.object({
  title: z.string(),
  document_date: z.string().nullable().describe("YYYY-MM-DD, the date the document was issued; null if none"),
  components: z.array(ComponentSchema),
  new_components: z.array(NewComponentSchema),
  new_objects: z.array(
    z.object({
      temp_id: z.string().describe("Short identifier; reference it from ref fields as new:<temp_id>"),
      title: z.string(),
      components: z.array(ComponentSchema),
    }),
  ),
  reasoning: z.string().describe("Two to five sentences for the human reviewer: what this is and why these components"),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You file documents into a personal document archive.

The archive uses an entity-component model instead of fixed document types:
- A component is a reusable, named group of typed fields (for example "Invoice": vendor, total, due date). A component with no fields acts as a tag.
- A document can carry any number of components. A car repair bill might carry Invoice + Related asset; a plumbing bill also carries Invoice + Related asset, but the asset points at the house.
- Objects are things that exist independently of any document (a specific car, a house, a person, an insurance policy, a bank account). They carry components too. Documents point at objects through fields of type "ref", so details about the car live once on the car object instead of being repeated on every bill.

Your job, for one newly scanned document: propose its title, its date, and the components (with field values) to attach. A human reviews your proposal in an inbox before anything is saved, so be accurate and leave out what you're unsure of instead of guessing.

Guidelines:
1. Prefer existing components. Attach every component whose purpose fits the document, and fill in as many of its fields as the document supports.
2. Propose a new component only when the document has important, reusable information that no existing component can hold, and the same component would plausibly be useful on future documents. Design it to be general (e.g. "insurance_policy", not "intact_home_policy_2024"), with a few well-chosen fields. Do not create a component that duplicates an existing one under another name. Do not propose new components for trivia.
3. Link documents to objects. If the document concerns a specific vehicle, property, person, account or similar, attach a component with a ref field pointing at the matching object. Match existing objects by strong identifiers (VIN, plate, address, account or policy number, name). If the document clearly concerns such a thing and no existing object matches, propose it in new_objects (with components describing it) and reference it as new:<temp_id>. Don't create objects for vendors or one-off counterparties unless they are something the owner would want to track.
4. Title: short and specific, in the form a person would want to see in a list, e.g. "Canadian Tire - brake service" or "Hydro bill - March 2025". Don't put the date in the title.

Value formats (all values are written as text):
- date: YYYY-MM-DD
- number / money: plain number with a dot as decimal separator, no currency symbol or thousands separator (e.g. 1234.56)
- boolean: true or false
- select: exactly one of the listed choices
- ref: the id of an existing object, or new:<temp_id> of an object in new_objects
- text / longtext: plain text
Leave a field out entirely when the document doesn't state it.`;

function describeField(f: FieldDef | ComponentInput["fields"][number]) {
  return {
    key: f.key,
    label: f.label,
    type: f.type,
    ...(f.required ? { required: true } : {}),
    ...(f.description ? { description: f.description } : {}),
    ...(f.options?.choices?.length ? { choices: f.options.choices } : {}),
    ...(f.options?.currency ? { currency: f.options.currency } : {}),
    ...(f.options?.component ? { must_point_at_object_with_component: f.options.component } : {}),
  };
}

function catalogJson(components: ComponentDef[]) {
  return components.map((c) => ({
    key: c.key,
    name: c.name,
    description: c.description,
    ...(c.aiHint ? { when_to_use: c.aiHint } : {}),
    fields: c.fields.map(describeField),
  }));
}

async function objectsForPrompt(catalog: Map<string, ComponentDef>) {
  const rows = await sql<{ id: string; title: string; notes: string }[]>`
    select id, title, notes from entity where kind = 'object' order by updated_at desc limit 500`;
  const comps = await loadComponents(sql, rows.map((r) => r.id));
  const ids = [...comps.values()].flatMap((cs) => cs.flatMap((c) => Object.values(c.values))).filter((v): v is string => typeof v === "string" && isUuid(v));
  const titles = await refTitles(sql, ids);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    components: describeComponents(comps.get(r.id) ?? [], catalog, titles),
    component_keys: (comps.get(r.id) ?? []).map((c) => c.component),
  }));
}

/** Filed documents whose text resembles this one, shown to the model as examples of how the owner files things. */
async function similarExamples(docId: string, content: string, catalog: Map<string, ComponentDef>) {
  if (config.ai.exampleCount <= 0) return [];
  const words = [...new Set(content.toLowerCase().match(/[a-z][a-z]{3,}/g) ?? [])].slice(0, 60);
  if (!words.length) return [];
  const query = words.join(" or ");
  const rows = await sql<{ id: string; title: string; document_date: string | null }[]>`
    select e.id, e.title, d.document_date
    from document d join entity e on e.id = d.entity_id
    where d.status = 'filed' and d.entity_id <> ${docId} and d.search @@ websearch_to_tsquery('english', ${query})
    order by ts_rank(d.search, websearch_to_tsquery('english', ${query})) desc
    limit ${config.ai.exampleCount}`;
  const comps = await loadComponents(sql, rows.map((r) => r.id));
  return rows.map((r) => ({
    title: r.title,
    document_date: r.document_date,
    components: (comps.get(r.id) ?? []).map((c) => ({ component: c.component, values: c.values })),
  }));
}

export async function analyzeDocument(docId: string): Promise<Proposal> {
  const [doc] = await sql<{ original_filename: string; content: string; archive_path: string | null; page_count: number | null; file_size: number }[]>`
    select original_filename, content, archive_path, page_count, file_size from document where entity_id = ${docId}`;
  if (!doc) throw new Error("Document not found");

  const components = await listComponents();
  const catalog = new Map(components.map((c) => [c.key, c]));
  const objects = await objectsForPrompt(catalog);
  const examples = await similarExamples(docId, doc.content, catalog);

  let content = doc.content;
  let truncationNote = "";
  if (content.length > config.ai.maxContentChars) {
    truncationNote = `\n(Text truncated: showing the first ${config.ai.maxContentChars} of ${content.length} characters.)`;
    content = content.slice(0, config.ai.maxContentChars);
  }

  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [];
  const attach =
    doc.archive_path &&
    doc.file_size <= config.ai.attachPdfMaxBytes &&
    (config.ai.attachPdf === "always" || (config.ai.attachPdf === "auto" && (doc.page_count ?? 99) <= 5));
  if (attach) {
    const pdf = await fs.readFile(path.join(config.dataDir, doc.archive_path!));
    userContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } });
  }
  userContent.push({
    type: "text",
    text: [
      examples.length
        ? `Previously filed documents that look similar (the owner reviewed these, so follow their conventions where they fit):\n${JSON.stringify(examples, null, 2)}\n`
        : "",
      `Original filename: ${doc.original_filename}`,
      doc.page_count ? `Pages: ${doc.page_count}` : "",
      attach ? "The PDF is attached; the OCR text below came from it." : "",
      `\n<document_text>\n${content || "(no text could be extracted)"}\n</document_text>${truncationNote}`,
      "\nPropose the title, date and components for this document.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const response = await anthropic().beta.messages.parse({
    model: config.ai.model,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: config.ai.effort, format: betaZodOutputFormat(AnalysisSchema) },
    system: [
      { type: "text", text: SYSTEM_PROMPT },
      {
        type: "text",
        text: `Component catalog:\n${JSON.stringify(catalogJson(components), null, 2)}\n\nExisting objects:\n${JSON.stringify(objects, null, 2)}`,
        // Catalog changes rarely; cache it across documents.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`The model declined to analyze this document${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("The model's answer was cut off (max_tokens).");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The model's answer did not match the expected format.");

  const { draft, warnings } = toDraft(parsed, catalog, new Set(objects.map((o) => o.id)));
  return { draft, reasoning: parsed.reasoning, model: response.model, createdAt: new Date().toISOString(), warnings };
}

/** Converts the model's output into a Draft, dropping anything that doesn't validate. */
export function toDraft(a: Analysis, catalog: Map<string, ComponentDef>, objectIds: Set<string>): { draft: Draft; warnings: string[] } {
  const warnings: string[] = [];

  const newComponents: ComponentInput[] = [];
  for (const nc of a.new_components) {
    if (catalog.has(nc.key)) {
      warnings.push(`Proposed component "${nc.key}" already exists; using the existing one.`);
      continue;
    }
    const input = newComponentInput(nc);
    const errs = validateComponentInput(input);
    if (errs.length) {
      warnings.push(`Dropped proposed component "${nc.key}": ${errs.join(" ")}`);
      continue;
    }
    newComponents.push(input);
  }
  const allDefs = new Map<string, Pick<ComponentDef, "name" | "fields">>(catalog);
  for (const nc of newComponents) {
    allDefs.set(nc.key, { name: nc.name, fields: nc.fields.map((f, i) => ({ ...f, id: "", position: i })) });
  }

  const tempIds = new Set(a.new_objects.map((o) => `new:${o.temp_id}`));
  const convert = (comps: Analysis["components"], where: string): DraftComponent[] =>
    comps.flatMap((c) => {
      const def = allDefs.get(c.component);
      if (!def) {
        warnings.push(`Dropped unknown component "${c.component}" on ${where}.`);
        return [];
      }
      const values: DraftComponent["values"] = {};
      for (const { field, value } of c.values) {
        const f = def.fields.find((x) => x.key === field);
        if (!f) {
          warnings.push(`Dropped unknown field ${c.component}.${field} on ${where}.`);
          continue;
        }
        const v = normalizeDraftValue(f, value);
        if (v === undefined) {
          warnings.push(`Dropped ${def.name} → ${f.label}: "${value}" is not a valid ${f.type}.`);
          continue;
        }
        if (f.type === "ref" && typeof v === "string" && !objectIds.has(v) && !tempIds.has(v)) {
          warnings.push(`Dropped ${def.name} → ${f.label}: it pointed at an unknown object.`);
          continue;
        }
        values[field] = v;
      }
      return [{ component: c.component, values }];
    });

  const newObjects = a.new_objects.map((o) => ({
    tempId: o.temp_id,
    title: o.title,
    components: convert(o.components, `new object "${o.title}"`),
  }));
  const draft: Draft = {
    title: a.title.trim(),
    documentDate: a.document_date ? parseDate(a.document_date) : null,
    components: convert(a.components, "the document"),
    newComponents,
    newObjects,
  };
  return { draft, warnings };
}

function newComponentInput(nc: z.infer<typeof NewComponentSchema>): ComponentInput {
  return {
    key: nc.key,
    name: nc.name,
    description: nc.description,
    aiHint: nc.ai_hint,
    fields: nc.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      description: f.description,
      required: f.required,
      options:
        f.type === "select" ? { choices: f.choices } :
        f.type === "money" && f.currency ? { currency: f.currency } :
        f.type === "ref" && f.ref_component ? { component: f.ref_component } : {},
    })),
  };
}

// ---------------------------------------------------------------------------

const GENERATE_PROMPT = `You design metadata components for a personal document archive that uses an entity-component model: a component is a reusable, named group of typed fields that can be attached to any document or object (car, house, person, account...). Documents link to objects through fields of type "ref".

Design one component from the user's description. Keep it general and reusable, with the fields a person would actually search, sort or total by. Use snake_case keys. Field types: text, longtext, number, money (set currency), date, boolean, select (give choices), ref (a link to an object; set ref_component when the target must carry a specific component). Don't duplicate fields that belong in a different existing component: if the description mixes concerns, design the component for the main concern and mention the overlap in the description.`;

export async function generateComponent(description: string): Promise<{ component: ComponentInput; notes: string }> {
  const components = await listComponents();
  const schema = z.object({ component: NewComponentSchema, notes: z.string().describe("One or two sentences for the user about design choices or overlap with existing components") });
  const response = await anthropic().beta.messages.parse({
    model: config.ai.model,
    max_tokens: 8000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: config.ai.effort, format: betaZodOutputFormat(schema) },
    system: GENERATE_PROMPT,
    messages: [
      {
        role: "user",
        content: `Existing components:\n${JSON.stringify(catalogJson(components), null, 2)}\n\nDesign a component for: ${description}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("The model's answer did not match the expected format.");
  return { component: newComponentInput(parsed.component), notes: parsed.notes };
}

export function aiAvailable(): boolean {
  return config.ai.enabled && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
