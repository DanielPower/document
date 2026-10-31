import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { aiAvailable, generateComponent } from "../services/ai.ts";
import { createComponent, deleteComponent, listComponents, updateComponent } from "../services/components.ts";
import { applyDraft, describeComponents, loadComponents, loadDraft, refTitles } from "../services/entities.ts";
import { deleteDocument, ingestBuffer } from "../services/ingest.ts";
import { searchDocuments } from "../services/search.ts";
import { isUuid } from "../services/values.ts";
import type { DocumentDetail, DocumentStatus, ObjectDetail, ObjectSummary, Proposal } from "../shared/types.ts";
import { ComponentInputSchema, DraftSchema } from "./schemas.ts";

const IdParams = z.object({ id: z.string().refine(isUuid, "invalid id") });
const asArray = (v: unknown) => (v === undefined ? undefined : Array.isArray(v) ? v.map(String) : String(v).split(",").filter(Boolean));

export async function apiRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- status
  app.get("/api/status", async () => {
    const counts = await sql<{ status: string; n: number }[]>`select status, count(*)::int as n from document group by status`;
    return {
      ai: aiAvailable(),
      model: config.ai.model,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    };
  });

  // ---------------------------------------------------------------- documents
  app.post("/api/documents", async (req) => {
    const results: Array<{ filename: string; id?: string; duplicate?: boolean; error?: string }> = [];
    for await (const part of req.files()) {
      try {
        const buf = await part.toBuffer();
        const r = await ingestBuffer(buf, part.filename);
        results.push({ filename: part.filename, ...r });
      } catch (err) {
        results.push({ filename: part.filename, error: (err as Error).message });
      }
    }
    return { results };
  });

  app.get("/api/documents", async (req) => {
    const q = req.query as Record<string, unknown>;
    return searchDocuments({
      q: q.q as string | undefined,
      status: asArray(q.status) as DocumentStatus[] | undefined,
      components: asArray(q.component),
      ref: q.ref && isUuid(String(q.ref)) ? String(q.ref) : undefined,
      where: asArray(q.where),
      from: q.from as string | undefined,
      to: q.to as string | undefined,
      sort: q.sort as never,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });

  app.get("/api/documents/:id", async (req): Promise<DocumentDetail> => {
    const { id } = IdParams.parse(req.params);
    const [d] = await sql`
      select e.id, e.title, d.status, d.original_filename, d.mime_type, d.document_date, d.added_at, d.page_count,
             d.thumb_path is not null as has_thumb, d.archive_path is not null as has_archive, d.error,
             d.content, d.file_size, d.proposal
      from document d join entity e on e.id = d.entity_id where e.id = ${id}`;
    if (!d) throw new HttpError(404, "Document not found.");
    const current = await loadDraft(sql, id);
    return {
      id: d.id,
      title: d.title,
      status: d.status,
      originalFilename: d.original_filename,
      mimeType: d.mime_type,
      documentDate: d.document_date,
      addedAt: d.added_at,
      pageCount: d.page_count,
      hasThumb: d.has_thumb,
      hasArchive: d.has_archive,
      error: d.error,
      content: d.content,
      fileSize: Number(d.file_size),
      components: current.components.map((c) => c.component),
      current,
      proposal: d.proposal as Proposal | null,
    };
  });

  app.get("/api/documents/:id/file", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const { kind, download } = req.query as { kind?: string; download?: string };
    const [d] = await sql<{ original_path: string; archive_path: string | null; mime_type: string; original_filename: string }[]>`
      select original_path, archive_path, mime_type, original_filename from document where entity_id = ${id}`;
    if (!d) throw new HttpError(404, "Document not found.");
    const useArchive = kind !== "original" && d.archive_path;
    const file = path.join(config.dataDir, useArchive ? d.archive_path! : d.original_path);
    const name = useArchive ? d.original_filename.replace(/\.[^.]+$/, "") + ".pdf" : d.original_filename;
    reply.header("content-type", useArchive ? "application/pdf" : d.mime_type);
    reply.header("content-disposition", `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(fs.createReadStream(file));
  });

  app.get("/api/documents/:id/thumb", async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const [d] = await sql<{ thumb_path: string | null }[]>`select thumb_path from document where entity_id = ${id}`;
    if (!d?.thumb_path) throw new HttpError(404, "No thumbnail.");
    reply.header("content-type", "image/png").header("cache-control", "private, max-age=86400");
    return reply.send(fs.createReadStream(path.join(config.dataDir, d.thumb_path)));
  });

  /** Saves a draft. With file=true the document leaves the inbox. */
  app.put("/api/documents/:id/draft", async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = z.object({ draft: DraftSchema, file: z.boolean().default(false) }).parse(req.body);
    const result = await sql.begin(async (tx) => {
      const [doc] = await tx`select status from document where entity_id = ${id} for update`;
      if (!doc) throw new HttpError(404, "Document not found.");
      const r = await applyDraft(tx, id, body.draft);
      if (body.file) await tx`update document set status = 'filed', proposal = null, error = null where entity_id = ${id}`;
      return r;
    });
    return { ok: true, ...result };
  });

  app.post("/api/documents/:id/reanalyze", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { ocr } = z.object({ ocr: z.boolean().default(false) }).parse(req.body ?? {});
    const [d] = await sql`
      update document set status = 'queued', attempts = 0, error = null, proposal = null, retry_at = null,
        content = case when ${ocr} then '' else content end,
        archive_path = case when ${ocr} then null else archive_path end
      where entity_id = ${id} and status in ('inbox', 'filed', 'failed') returning entity_id`;
    if (!d) throw new HttpError(409, "The document is already being processed.");
    return { ok: true };
  });

  app.delete("/api/documents/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    await deleteDocument(id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- components
  app.get("/api/components", async () => listComponents());

  app.post("/api/components", async (req) => {
    const input = ComponentInputSchema.parse(req.body);
    const id = await sql.begin((tx) => createComponent(tx, input));
    return { id };
  });

  app.put("/api/components/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const input = ComponentInputSchema.parse(req.body);
    await sql.begin(async (tx) => {
      await updateComponent(tx, id, input);
      const docs = await tx<{ entity_id: string }[]>`
        select distinct ci.entity_id from component_instance ci join document d on d.entity_id = ci.entity_id where ci.component_id = ${id}`;
      for (const d of docs) await tx`select refresh_document_search(${d.entity_id})`;
    });
    return { ok: true };
  });

  app.delete("/api/components/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const force = (req.query as { force?: string }).force === "1";
    await sql.begin((tx) => deleteComponent(tx, id, force));
    return { ok: true };
  });

  app.post("/api/ai/generate-component", async (req) => {
    if (!aiAvailable()) throw new HttpError(503, "AI is not configured (set ANTHROPIC_API_KEY).");
    const { description } = z.object({ description: z.string().min(3) }).parse(req.body);
    return generateComponent(description);
  });

  // ---------------------------------------------------------------- objects
  app.get("/api/objects", async (req): Promise<ObjectSummary[]> => {
    const { q, component } = req.query as { q?: string; component?: string };
    const rows = await sql<{ id: string; title: string; notes: string; document_count: number }[]>`
      select e.id, e.title, e.notes,
        (select count(distinct ci.entity_id)::int from field_value fv join component_instance ci on ci.id = fv.instance_id
          where fv.value_ref = e.id) as document_count
      from entity e
      where e.kind = 'object'
        ${q ? sql`and e.title ilike ${"%" + q + "%"}` : sql``}
        ${component ? sql`and exists (select 1 from component_instance ci join component_def cd on cd.id = ci.component_id
                                       where ci.entity_id = e.id and cd.key = ${component})` : sql``}
      order by e.title`;
    const comps = await loadComponents(sql, rows.map((r) => r.id));
    const catalog = new Map((await listComponents()).map((c) => [c.key, c]));
    const refs = [...comps.values()].flatMap((cs) => cs.flatMap((c) => Object.values(c.values))).filter((v): v is string => typeof v === "string" && isUuid(v));
    const titles = await refTitles(sql, refs);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      notes: r.notes,
      documentCount: r.document_count,
      components: (comps.get(r.id) ?? []).map((c) => c.component),
      summary: describeComponents(comps.get(r.id) ?? [], catalog, titles),
    }));
  });

  app.get("/api/objects/:id", async (req): Promise<ObjectDetail> => {
    const { id } = IdParams.parse(req.params);
    const [o] = await sql<{ id: string; title: string; notes: string }[]>`select id, title, notes from entity where id = ${id} and kind = 'object'`;
    if (!o) throw new HttpError(404, "Object not found.");
    const current = await loadDraft(sql, id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(distinct ci.entity_id)::int as n from field_value fv join component_instance ci on ci.id = fv.instance_id where fv.value_ref = ${id}`;
    return { ...o, documentCount: n, components: current.components.map((c) => c.component), summary: "", current };
  });

  const ObjectBody = z.object({ draft: DraftSchema, notes: z.string().optional() });

  app.post("/api/objects", async (req) => {
    const body = ObjectBody.parse(req.body);
    const id = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`insert into entity (kind, title, notes) values ('object', ${body.draft.title}, ${body.notes ?? ""}) returning id`;
      await applyDraft(tx, row.id, body.draft);
      return row.id;
    });
    return { id };
  });

  app.put("/api/objects/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const body = ObjectBody.parse(req.body);
    await sql.begin(async (tx) => {
      const [o] = await tx`select 1 from entity where id = ${id} and kind = 'object'`;
      if (!o) throw new HttpError(404, "Object not found.");
      await applyDraft(tx, id, body.draft);
      if (body.notes !== undefined) await tx`update entity set notes = ${body.notes} where id = ${id}`;
    });
    return { ok: true };
  });

  app.delete("/api/objects/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const [o] = await sql`delete from entity where id = ${id} and kind = 'object' returning id`;
    if (!o) throw new HttpError(404, "Object not found.");
    return { ok: true };
  });
}
