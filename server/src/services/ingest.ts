import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { HttpError } from "../errors.ts";

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/tiff": ".tif",
  "image/gif": ".gif",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

/** Identifies the file by its bytes; the client-supplied type is not trusted. */
export function sniffMime(buf: Buffer, filename: string): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  const head4 = buf.subarray(0, 4).toString("latin1");
  if (head4 === "II*\0" || head4 === "MM\0*") return "image/tiff";
  if (head4 === "GIF8") return "image/gif";
  const ext = path.extname(filename).toLowerCase();
  if ([".txt", ".md", ".markdown"].includes(ext) && !buf.includes(0)) {
    return ext === ".txt" ? "text/plain" : "text/markdown";
  }
  return null;
}

export interface IngestResult {
  id: string;
  duplicate: boolean;
}

export async function ingestBuffer(buf: Buffer, filename: string): Promise<IngestResult> {
  const mime = sniffMime(buf, filename);
  if (!mime) throw new HttpError(415, `Unsupported file type: ${filename}. Supported: PDF, PNG, JPEG, TIFF, GIF, TXT, MD.`);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  const [dupe] = await sql<{ entity_id: string }[]>`select entity_id from document where sha256 = ${sha256}`;
  if (dupe) return { id: dupe.entity_id, duplicate: true };

  const id = crypto.randomUUID();
  const now = new Date();
  const rel = path.join("originals", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), id + EXT_BY_MIME[mime]);
  const abs = path.join(config.dataDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buf);

  const title = path.basename(filename, path.extname(filename)).replace(/[_]+/g, " ").trim() || "Untitled";
  try {
    await sql.begin(async (tx) => {
      await tx`insert into entity (id, kind, title) values (${id}, 'document', ${title})`;
      await tx`
        insert into document (entity_id, original_filename, mime_type, file_size, sha256, original_path)
        values (${id}, ${filename}, ${mime}, ${buf.length}, ${sha256}, ${rel})`;
    });
  } catch (err) {
    await fs.rm(abs, { force: true });
    // Lost a race with an identical upload.
    const [again] = await sql<{ entity_id: string }[]>`select entity_id from document where sha256 = ${sha256}`;
    if (again) return { id: again.entity_id, duplicate: true };
    throw err;
  }
  return { id, duplicate: false };
}

/** Deletes a document and its files. */
export async function deleteDocument(id: string): Promise<void> {
  const [doc] = await sql<{ original_path: string; archive_path: string | null; thumb_path: string | null }[]>`
    select original_path, archive_path, thumb_path from document where entity_id = ${id}`;
  if (!doc) throw new HttpError(404, "Document not found.");
  await sql`delete from entity where id = ${id}`;
  for (const p of [doc.original_path, doc.archive_path, doc.thumb_path]) {
    if (p) await fs.rm(path.join(config.dataDir, p), { force: true });
  }
}

/**
 * Polls the consume directory. A file is ingested once its size has been
 * stable for one poll (so half-copied scans aren't picked up), then removed.
 */
export function startConsumeWatcher(log: (msg: string) => void): void {
  if (!config.consumeDir) return;
  const lastSize = new Map<string, number>();
  const tick = async () => {
    try {
      await fs.mkdir(config.consumeDir, { recursive: true });
      const names = await listFiles(config.consumeDir);
      for (const file of names) {
        const stat = await fs.stat(file).catch(() => null);
        if (!stat) continue;
        if (lastSize.get(file) !== stat.size) {
          lastSize.set(file, stat.size);
          continue;
        }
        lastSize.delete(file);
        try {
          const res = await ingestBuffer(await fs.readFile(file), path.basename(file));
          log(`consumed ${file} -> ${res.id}${res.duplicate ? " (duplicate)" : ""}`);
          await fs.rm(file);
        } catch (err) {
          log(`could not consume ${file}: ${(err as Error).message}`);
          const failedDir = path.join(config.consumeDir, ".failed");
          await fs.mkdir(failedDir, { recursive: true });
          await fs.rename(file, path.join(failedDir, path.basename(file))).catch(() => {});
        }
      }
    } catch (err) {
      log(`consume watcher error: ${(err as Error).message}`);
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 1000);
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listFiles(p)));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}
