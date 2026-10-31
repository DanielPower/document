import { config } from "../config.ts";
import { sql } from "../db.ts";
import { chunkText } from "./chunking.ts";

/**
 * Semantic search: documents are split into chunks, each chunk is embedded by
 * an OpenAI-compatible embeddings API (llama-swap in the homelab), and vectors
 * are stored with pgvector. Everything here degrades gracefully: when the API
 * or the extension is missing, semantic search is off and the rest works.
 */

interface State {
  available: boolean;
  reason: string;
  dims: number;
}

const state: State = { available: false, reason: "not initialized", dims: 0 };

export function semanticStatus(): { available: boolean; reason: string; model: string } {
  return { available: state.available, reason: state.reason, model: config.embeddings.model };
}

export function semanticAvailable(): boolean {
  return state.available;
}

/** Calls the embeddings API. Returns unit-length vectors in input order. */
async function callApi(inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${config.embeddings.url}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.embeddings.apiKey ? { authorization: `Bearer ${config.embeddings.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.embeddings.model, input: inputs }),
    // A cold model may need to load first.
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`embeddings API returned ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
  if (!Array.isArray(json.data) || json.data.length !== inputs.length) {
    throw new Error("embeddings API returned an unexpected response");
  }
  return json.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => normalize(d.embedding));
}

function normalize(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / len);
}

const BATCH = 16;

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await callApi(texts.slice(i, i + BATCH).map((t) => config.embeddings.documentPrefix + t))));
  }
  return out;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [v] = await callApi([config.embeddings.queryPrefix + text]);
  return v;
}

/** pgvector's text input format. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(7) : "0")).join(",")}]`;
}

/**
 * Checks the embeddings API and pgvector, and creates the chunk table sized to
 * the model's dimensions. Switching to a model with different dimensions drops
 * the old vectors and re-embeds everything in the background.
 */
async function initSemantic(log: (m: string) => void): Promise<"on" | "off" | "retry"> {
  const off = (reason: string, result: "off" | "retry" = "off") => {
    state.available = false;
    state.reason = reason;
    log(`semantic search off: ${reason}${result === "retry" ? " (will keep trying)" : ""}`);
    return result;
  };
  if (!config.embeddings.url) return off("EMBEDDING_URL is not set");

  const [ext] = await sql<{ installed: boolean; available: boolean }[]>`
    select exists (select 1 from pg_extension where extname = 'vector') as installed,
           exists (select 1 from pg_available_extensions where name = 'vector') as available`;
  if (!ext.installed) {
    if (!ext.available) {
      return off("the pgvector extension is not installed on the Postgres server");
    }
    try {
      await sql`create extension if not exists vector`;
    } catch (err) {
      return off(
        `pgvector is installed on the server but not enabled in this database, and this role can't enable it ` +
          `(${(err as Error).message}). Run as a superuser: CREATE EXTENSION vector;`,
      );
    }
  }

  let dims: number;
  try {
    dims = (await embedQuery("dimension probe")).length;
  } catch (err) {
    return off(`can't reach the embeddings API at ${config.embeddings.url}: ${(err as Error).message}`, "retry");
  }

  // atttypmod holds a vector column's dimensions.
  const [col] = await sql<{ dims: number }[]>`
    select a.atttypmod as dims from pg_attribute a
    where a.attrelid = to_regclass('document_chunk') and a.attname = 'embedding'`;
  if (col && col.dims !== dims) {
    log(`embedding dimensions changed (${col.dims} -> ${dims}); dropping old vectors, documents will be re-embedded`);
    await sql`drop table document_chunk`;
    await sql`update document set embedded_model = null`;
  }
  await sql.unsafe(`
    create table if not exists document_chunk (
      entity_id uuid not null references entity(id) on delete cascade,
      chunk     int not null,
      content   text not null,
      embedding vector(${dims}) not null,
      primary key (entity_id, chunk)
    )`);
  // No vector index on purpose: searches combine similarity with arbitrary
  // filters, and an exact scan is fast at personal-archive sizes.

  state.available = true;
  state.dims = dims;
  state.reason = "";
  log(`semantic search on: ${config.embeddings.model} (${dims} dimensions)`);
  return "on";
}

/**
 * Turns semantic search on, retrying in the background while the embeddings
 * API is unreachable (e.g. llama-swap starting after Docket). Once on, starts
 * the embedding job when this process runs the worker.
 */
export function startSemantic(log: (m: string) => void, runJob: boolean): void {
  let attempt = 0;
  const tryInit = async () => {
    let result: "on" | "off" | "retry";
    try {
      result = await initSemantic(log);
    } catch (err) {
      log(`semantic search setup failed: ${(err as Error).message}`);
      result = "retry";
    }
    if (result === "on" && runJob) startEmbeddingJob(log);
    if (result === "retry") setTimeout(tryInit, Math.min(30_000 * 2 ** attempt++, 600_000));
  };
  void tryInit();
}

/** Embeds one document: chunk 0 is the title, chunks 1.. are the OCR text. */
export async function embedDocument(id: string): Promise<void> {
  const [doc] = await sql<{ title: string; content: string }[]>`
    select e.title, d.content from document d join entity e on e.id = d.entity_id where d.entity_id = ${id}`;
  if (!doc) return;
  const texts = [doc.title, ...chunkText(doc.content, config.embeddings.chunkChars)].filter((t) => t.trim());
  const vectors = texts.length ? await embedDocuments(texts) : [];
  await sql.begin(async (tx) => {
    await tx`delete from document_chunk where entity_id = ${id}`;
    for (let i = 0; i < texts.length; i++) {
      await tx`
        insert into document_chunk (entity_id, chunk, content, embedding)
        values (${id}, ${i}, ${texts[i]}, ${toVectorLiteral(vectors[i])}::vector)`;
    }
    await tx`update document set embedded_model = ${config.embeddings.model} where entity_id = ${id}`;
  });
}

/** Re-embeds only the title chunk, after a document is renamed. */
export async function refreshTitleChunk(id: string): Promise<void> {
  if (!state.available) return;
  const [doc] = await sql<{ title: string; embedded: boolean }[]>`
    select e.title, d.embedded_model = ${config.embeddings.model} as embedded
    from document d join entity e on e.id = d.entity_id where d.entity_id = ${id}`;
  // Not embedded yet: the background job will do the whole document.
  if (!doc?.embedded || !doc.title.trim()) return;
  const [v] = await embedDocuments([doc.title]);
  await sql`
    insert into document_chunk (entity_id, chunk, content, embedding)
    values (${id}, 0, ${doc.title}, ${toVectorLiteral(v)}::vector)
    on conflict (entity_id, chunk) do update set content = excluded.content, embedding = excluded.embedding`;
}

let wake: (() => void) | null = null;

/** Asks the background job to look for work now (e.g. right after OCR). */
export function kickEmbeddings(): void {
  wake?.();
}

/**
 * Embeds documents that have text but no vectors for the current model: new
 * documents, and every document after a model change.
 */
function startEmbeddingJob(log: (m: string) => void): void {
  if (!state.available) return;
  let failures = 0;
  const loop = async () => {
    for (;;) {
      let did = 0;
      try {
        const rows = await sql<{ entity_id: string }[]>`
          select entity_id from document
          where status in ('analyzing', 'inbox', 'filed')
            and embedded_model is distinct from ${config.embeddings.model}
          order by added_at desc
          limit 10`;
        for (const r of rows) {
          await embedDocument(r.entity_id);
          did++;
        }
        failures = 0;
      } catch (err) {
        failures++;
        log(`embedding failed: ${(err as Error).message}`);
      }
      if (did === 10) continue;
      // Back off while the embeddings API is down (30s, 1m, 2m, ... up to 10m).
      const delay = failures ? Math.min(30_000 * 2 ** (failures - 1), 600_000) : 60_000;
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, delay);
      });
    }
  };
  void loop();
}
