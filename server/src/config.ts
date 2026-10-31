import path from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

const dataDir = path.resolve(env("DATA_DIR", "./data"));

export const config = {
  databaseUrl: env("DATABASE_URL"),
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  dataDir,
  /** Files dropped here are ingested and then removed. Empty string disables it. */
  consumeDir: env("CONSUME_DIR", path.join(dataDir, "consume")),
  /** Run the processing worker inside the web server process. */
  runWorker: env("RUN_WORKER", "true") === "true",
  workerConcurrency: Number(env("WORKER_CONCURRENCY", "2")),
  ocr: {
    /** Tesseract language codes joined with "+", e.g. "eng+fra". */
    languages: env("OCR_LANGUAGES", "eng"),
    ocrmypdfBin: env("OCRMYPDF_BIN", "ocrmypdf"),
  },
  ai: {
    enabled: env("AI_ENABLED", "true") === "true",
    model: env("AI_MODEL", "claude-opus-5-5"),
    effort: env("AI_EFFORT", "medium") as "low" | "medium" | "high" | "xhigh" | "max",
    /** OCR text beyond this many characters is cut, and the model is told so. */
    maxContentChars: Number(env("AI_MAX_CONTENT_CHARS", "60000")),
    /** never | auto | always: also send the PDF itself so the model can see layout. */
    attachPdf: env("AI_ATTACH_PDF", "auto") as "never" | "auto" | "always",
    /** Documents larger than this are never sent as PDF (bytes). */
    attachPdfMaxBytes: Number(env("AI_ATTACH_PDF_MAX_BYTES", String(15 * 1024 * 1024))),
    /** How many already-filed similar documents to show the model as examples. */
    exampleCount: Number(env("AI_EXAMPLE_COUNT", "3")),
  },
};
