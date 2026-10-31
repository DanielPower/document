import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";

const run = promisify(execFile);

export interface OcrResult {
  content: string;
  archivePath: string | null;
  thumbPath: string | null;
  pageCount: number | null;
}

export function isOcrable(mime: string): boolean {
  return mime === "application/pdf" || mime.startsWith("image/");
}

/**
 * Produces a searchable PDF (text layer added where pages have none), extracts
 * its text, and renders a first-page thumbnail. Plain-text files are read as-is.
 */
export async function runOcr(opts: { id: string; originalPath: string; mime: string }): Promise<OcrResult> {
  const original = path.join(config.dataDir, opts.originalPath);
  if (opts.mime.startsWith("text/")) {
    return { content: await fs.readFile(original, "utf8"), archivePath: null, thumbPath: null, pageCount: null };
  }

  const archiveRel = path.join("archive", `${opts.id}.pdf`);
  const thumbRel = path.join("thumbs", `${opts.id}.png`);
  const archive = path.join(config.dataDir, archiveRel);
  const thumbBase = path.join(config.dataDir, "thumbs", opts.id);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.mkdir(path.dirname(thumbBase), { recursive: true });

  const args = [
    "--skip-text", // keep born-digital text; only OCR pages that are images
    "--rotate-pages",
    "--output-type", "pdf",
    "-l", config.ocr.languages,
    "-j", "1",
    "-q",
  ];
  if (opts.mime.startsWith("image/")) args.push("--image-dpi", "300");
  try {
    await run(config.ocr.ocrmypdfBin, [...args, original, archive], { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { code?: number | string; stderr?: string; message: string };
    // ocrmypdf exit codes: 2 bad input, 8 encrypted PDF, 6 "already has text" (not raised with --skip-text)
    const detail = (e.stderr || e.message).trim().split("\n").slice(-5).join("\n");
    if (e.code === 8) throw new Error("The PDF is encrypted; decrypt it and upload again.");
    if (e.code === "ENOENT") throw new Error(`OCR tool not found: ${config.ocr.ocrmypdfBin}. Is OCRmyPDF installed?`);
    throw new Error(`OCR failed (exit ${e.code}): ${detail}`);
  }

  const { stdout: text } = await run("pdftotext", ["-layout", "-enc", "UTF-8", archive, "-"], { maxBuffer: 256 * 1024 * 1024 });
  const { stdout: info } = await run("pdfinfo", [archive]);
  const pages = /^Pages:\s+(\d+)/m.exec(info);

  let thumbPath: string | null = null;
  try {
    await run("pdftoppm", ["-png", "-f", "1", "-l", "1", "-singlefile", "-scale-to", "480", archive, thumbBase]);
    thumbPath = thumbRel;
  } catch {
    // A missing thumbnail is cosmetic.
  }

  return {
    content: cleanText(text),
    archivePath: archiveRel,
    thumbPath,
    pageCount: pages ? Number(pages[1]) : null,
  };
}

function cleanText(s: string): string {
  return s
    .replace(/\f/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
