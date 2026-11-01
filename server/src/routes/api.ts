import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";
import { aiAvailable, analyzeDocument, generateComponent } from "../services/ai.ts";
import { createComponent, deleteComponent, listComponents, updateComponent } from "../services/components.ts";
import { applyDraft, describeComponents, loadComponents, loadDraft, refTitles } from "../services/entities.ts";
import { deleteDocument, ingestBuffer, purgeTrash, restoreDocument, trashDocument } from "../services/ingest.ts";
import { findDuplicates, mergeObjects, reconcileDraft } from "../services/objects.ts";
import { aggregateDocuments, searchDocuments, type SearchParams } from "../services/search.ts";
import { askQuestion, interpretQuestion } from "../services/ai-query.ts";
import { refreshTitleChunk, semanticStatus } from "../services/embeddings.ts";
import { isUuid } from "../services/values.ts";
import type { DocumentDetail, DocumentStatus, DraftValue, ObjectDetail, ObjectSummary, Proposal } from "../shared/types.ts";
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
      semantic: semanticStatus(),
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

  /**
   * Target of the PWA's share_target (web/public/manifest.webmanifest): Android's share sheet
   * posts the shared files here as a form submission, so answer with a redirect into the app.
   * The web UI shows `notice` and `error` as toasts.
   */
  app.post("/share", async (req, reply) => {
    const added: string[] = [];
    const dupes: string[] = [];
    const errors: string[] = [];
    try {
      for await (const part of req.files()) {
        try {
          const r = await ingestBuffer(await part.toBuffer(), part.filename || "Shared file");
          (r.duplicate ? dupes : added).push(r.id);
        } catch (err) {
          errors.push(`${part.filename}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
    const notice = [
      added.length > 1 ? `Added ${added.length} files; processing…` : added.length ? "Added; processing…" : "",
      dupes.length ? `${dupes.length === 1 ? "That file was" : `${dupes.length} files were`} already in the archive.` : "",
      !added.length && !dupes.length && !errors.length ? "Nothing to add: share a PDF, image or text file." : "",
    ].filter(Boolean).join("\n");
    const query = new URLSearchParams();
    if (notice) query.set("notice", notice);
    if (errors.length) query.set("error", errors.join("\n"));
    const target = added.length === 1 && !dupes.length ? `/inbox/${added[0]}` : !added.length && dupes.length === 1 ? `/documents/${dupes[0]}` : "/";
    return reply.redirect(`${target}?${query}`, 303);
  });

  const searchParams = (q: Record<string, unknown>): SearchParams => ({
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
    semantic: q.semantic !== "0" && q.semantic !== false,
    values: q.values === "1",
  });

  app.get("/api/documents", async (req) => searchDocuments(searchParams(req.query as Record<string, unknown>)));

  const AggregateBody = z.object({
    fn: z.enum(["count", "sum", "avg", "min", "max"]),
    component: z.string().optional(),
    field: z.string().optional(),
    groupBy: z.enum(["none", "year", "month", "object"]).default("none"),
  });

  /** Totals over the documents matching the same filters as GET /api/documents (passed as the query string). */
  app.post("/api/documents/aggregate", async (req) => {
    const spec = AggregateBody.parse(req.body);
    return aggregateDocuments(searchParams(req.query as Record<string, unknown>), spec);
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
    // Re-check inbox proposals against objects filed since they were made
    // (documents analysed in the same batch can't see each other's new objects).
    let proposal = d.proposal as Proposal | null;
    if (proposal && d.status === "inbox") {
      const { draft, notes } = await reconcileDraft(sql, proposal.draft);
      proposal = { ...proposal, draft, matched: [...new Set([...(proposal.matched ?? []), ...notes])] };
    }
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
      proposal,
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
    // The title is embedded for semantic search; refresh it in the background.
    refreshTitleChunk(id).catch((err) => req.log.warn(`title embedding failed: ${(err as Error).message}`));
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

  /**
   * Asks the AI to revise an inbox proposal: takes the draft as the owner left
   * it plus what they want changed, and stores the revised proposal.
   */
  app.post("/api/documents/:id/revise", async (req): Promise<Proposal> => {
    if (!aiAvailable()) throw new HttpError(503, "AI is not configured (set ANTHROPIC_API_KEY).");
    const { id } = IdParams.parse(req.params);
    const body = z.object({ draft: DraftSchema, feedback: z.string().trim().min(2).max(4000) }).parse(req.body);
    const [doc] = await sql<{ status: string; proposal: Proposal | null }[]>`select status, proposal from document where entity_id = ${id}`;
    if (!doc) throw new HttpError(404, "Document not found.");
    if (doc.status !== "inbox") throw new HttpError(409, "Only documents in the inbox can be revised.");
    let proposal: Proposal;
    try {
      proposal = await analyzeDocument(id, { draft: body.draft, feedback: body.feedback, previousFeedback: doc.proposal?.feedback ?? [] });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `The AI couldn't revise the proposal: ${(err as Error).message}`);
    }
    await sql`update document set proposal = ${sql.json(proposal as never)}, error = null where entity_id = ${id} and status = 'inbox'`;
    return proposal;
  });

  /** Moves the document to the trash; with ?forever=1 deletes it and its files now. */
  app.delete("/api/documents/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    if ((req.query as { forever?: string }).forever === "1") await deleteDocument(id);
    else await trashDocument(id);
    return { ok: true };
  });

  app.post("/api/documents/:id/restore", async (req) => {
    const { id } = IdParams.parse(req.params);
    await restoreDocument(id);
    return { ok: true };
  });

  /** Empties the trash. */
  app.delete("/api/trash", async () => ({ deleted: await purgeTrash(true) }));

  /** Puts a filed document back in the inbox, as filed (the undo for filing). */
  app.post("/api/documents/:id/unfile", async (req) => {
    const { id } = IdParams.parse(req.params);
    const [d] = await sql`update document set status = 'inbox' where entity_id = ${id} and status = 'filed' returning entity_id`;
    if (!d) throw new HttpError(409, "Only filed documents can go back to the inbox.");
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

  const Question = z.object({ question: z.string().trim().min(2).max(2000) });

  /** Turns a natural-language question into structured search filters (and an optional total). */
  app.post("/api/ai/interpret", async (req) => {
    if (!aiAvailable()) throw new HttpError(503, "AI is not configured (set ANTHROPIC_API_KEY).");
    return interpretQuestion(Question.parse(req.body).question);
  });

  /** Answers a question about the archive, citing the documents used. `history` makes it a follow-up. */
  app.post("/api/ai/ask", async (req) => {
    if (!aiAvailable()) throw new HttpError(503, "AI is not configured (set ANTHROPIC_API_KEY).");
    const body = Question.extend({
      history: z.array(z.object({ question: z.string().max(2000), answer: z.string().max(20000) })).max(20).default([]),
    }).parse(req.body);
    return askQuestion(body.question, body.history);
  });

  // ---------------------------------------------------------------- objects
  app.get("/api/objects", async (req): Promise<ObjectSummary[]> => {
    const { q, component } = req.query as { q?: string; component?: string };
    const rows = await sql<{ id: string; title: string; notes: string; document_count: number }[]>`
      select e.id, e.title, e.notes,
        (select count(distinct ci.entity_id)::int from field_value fv join component_instance ci on ci.id = fv.instance_id
            join document cd on cd.entity_id = ci.entity_id and cd.status <> 'trashed'
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
      select count(distinct ci.entity_id)::int as n from field_value fv join component_instance ci on ci.id = fv.instance_id join document cd on cd.entity_id = ci.entity_id and cd.status <> 'trashed' where fv.value_ref = ${id}`;
    const linkedFrom = await sql<{ id: string; title: string }[]>`
      select distinct e.id, e.title from field_value fv
      join component_instance ci on ci.id = fv.instance_id
      join entity e on e.id = ci.entity_id and e.kind = 'object'
      where fv.value_ref = ${id} and e.id <> ${id}
      order by e.title`;
    // Where each detail came from, while it still holds the value that document set.
    const sourceRows = await sql<{ component: string; field: string; document_id: string; title: string; value: DraftValue; set_at: string }[]>`
      select s.component, s.field, s.document_id, e.title, s.value, s.set_at
      from object_field_source s join entity e on e.id = s.document_id
      join document d on d.entity_id = s.document_id and d.status <> 'trashed'
      where s.object_id = ${id}`;
    const sources = sourceRows
      .filter((r) => current.components.some((c) => c.component === r.component && c.values[r.field] === r.value))
      .map((r) => ({ component: r.component, field: r.field, documentId: r.document_id, documentTitle: r.title, setAt: r.set_at }));
    return { ...o, documentCount: n, components: current.components.map((c) => c.component), summary: "", current, linkedFrom: [...linkedFrom], sources };
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

  /**
   * Re-checks a draft for proposed new objects that already exist. `sameAs`
   * maps a proposed object's tempId to an existing object the owner picked.
   */
  app.post("/api/drafts/reconcile", async (req) => {
    const body = z.object({ draft: DraftSchema, sameAs: z.record(z.string(), z.string().uuid()).default({}) }).parse(req.body);
    return reconcileDraft(sql, body.draft, body.sameAs);
  });

  /** Objects that look like duplicates of each other. */
  app.get("/api/objects/duplicates", async () => {
    const groups = await findDuplicates(sql);
    if (!groups.length) return [];
    const ids = groups.flatMap((g) => g.ids);
    const rows = await sql<{ id: string; title: string; document_count: number }[]>`
      select e.id, e.title,
        (select count(distinct ci.entity_id)::int from field_value fv join component_instance ci on ci.id = fv.instance_id join document cd on cd.entity_id = ci.entity_id and cd.status <> 'trashed' where fv.value_ref = e.id) as document_count
      from entity e where e.id = any(${ids}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return groups.map((g) => ({
      reason: g.reason,
      certain: g.certain,
      objects: g.ids.map((id) => ({ id, title: byId.get(id)!.title, documentCount: byId.get(id)!.document_count })),
    }));
  });

  /** Merges this object into another: links move, missing details are filled in, this one is deleted. */
  app.post("/api/objects/:id/merge", async (req) => {
    const { id } = IdParams.parse(req.params);
    const { into } = z.object({ into: z.string().uuid() }).parse(req.body);
    return sql.begin((tx) => mergeObjects(tx, id, into));
  });

  app.delete("/api/objects/:id", async (req) => {
    const { id } = IdParams.parse(req.params);
    const [o] = await sql`delete from entity where id = ${id} and kind = 'object' returning id`;
    if (!o) throw new HttpError(404, "Object not found.");
    return { ok: true };
  });
}
