import { config } from "./config.js";
import { sql } from "./db.js";
import { aiAvailable, analyzeDocument } from "./services/ai.js";
import { runOcr } from "./services/ocr.js";

const MAX_ATTEMPTS = 3;
/** A job locked longer than this is assumed to belong to a crashed worker. */
const STALE_LOCK = "30 minutes";

interface Job {
  entity_id: string;
  original_path: string;
  mime_type: string;
  archive_path: string | null;
  attempts: number;
  reprocess_ocr: boolean;
}

/**
 * Pipeline: queued -> ocr -> analyzing -> inbox.
 * The document row is the job: workers claim rows with SKIP LOCKED, so several
 * workers (or containers) can run side by side without a separate queue.
 */
async function claim(): Promise<Job | null> {
  const [job] = await sql<Job[]>`
    update document d set status = 'ocr', locked_at = now(), attempts = d.attempts + 1, error = null
    where d.entity_id = (
      select entity_id from document
      where status = 'queued'
         or (status in ('ocr', 'analyzing') and locked_at < now() - ${STALE_LOCK}::interval)
      order by added_at
      for update skip locked
      limit 1)
    returning d.entity_id, d.original_path, d.mime_type, d.archive_path, d.attempts,
              d.archive_path is null and d.content = '' as reprocess_ocr`;
  return job ?? null;
}

async function processJob(job: Job, log: (m: string) => void): Promise<void> {
  const id = job.entity_id;
  try {
    // OCR is skipped when re-analyzing a document that already has text.
    if (job.reprocess_ocr) {
      const ocr = await runOcr({ id, originalPath: job.original_path, mime: job.mime_type });
      await sql`
        update document set content = ${ocr.content}, archive_path = ${ocr.archivePath},
          thumb_path = ${ocr.thumbPath}, page_count = ${ocr.pageCount}
        where entity_id = ${id}`;
      await sql`select refresh_document_search(${id})`;
    }
  } catch (err) {
    const msg = (err as Error).message;
    log(`OCR failed for ${id} (attempt ${job.attempts}): ${msg}`);
    await sql`
      update document set status = ${job.attempts >= MAX_ATTEMPTS ? "failed" : "queued"}, error = ${msg}, locked_at = null
      where entity_id = ${id}`;
    return;
  }

  // AI problems never block a document: it lands in the inbox either way.
  let proposalError: string | null = null;
  if (aiAvailable()) {
    await sql`update document set status = 'analyzing', locked_at = now() where entity_id = ${id}`;
    try {
      const proposal = await analyzeDocument(id);
      await sql`update document set proposal = ${sql.json(proposal as never)} where entity_id = ${id}`;
    } catch (err) {
      proposalError = `AI analysis failed: ${(err as Error).message}`;
      log(`${proposalError} (${id})`);
    }
  } else {
    proposalError = config.ai.enabled ? "AI is not configured (set ANTHROPIC_API_KEY)." : null;
  }
  await sql`update document set status = 'inbox', locked_at = null, attempts = 0, error = ${proposalError} where entity_id = ${id}`;
  log(`document ${id} ready in inbox`);
}

export function startWorker(log: (m: string) => void): void {
  let running = 0;
  let wake: (() => void) | null = null;

  const loop = async () => {
    for (;;) {
      if (running >= config.workerConcurrency) {
        await new Promise<void>((r) => (wake = r));
        continue;
      }
      let job: Job | null = null;
      try {
        job = await claim();
      } catch (err) {
        log(`worker claim error: ${(err as Error).message}`);
      }
      if (!job) {
        // Sleep until notified or 30s pass (the timeout also catches stale locks).
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 30_000);
        });
        continue;
      }
      running++;
      processJob(job, log)
        .catch((err) => log(`worker error: ${(err as Error).message}`))
        .finally(() => {
          running--;
          wake?.();
        });
    }
  };

  sql.listen("docket_jobs", () => wake?.()).catch((err) => log(`listen failed: ${err.message}`));
  void loop();
  log(`worker started (concurrency ${config.workerConcurrency}, AI ${aiAvailable() ? `on: ${config.ai.model}` : "off"})`);
}
