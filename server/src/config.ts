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
    /** Most tool calls the Ask assistant may make for one question. */
    askMaxSteps: Number(env("AI_ASK_MAX_STEPS", "8")),
  },
  embeddings: {
    /**
     * Base URL of an OpenAI-compatible embeddings API (llama-swap, llama-server,
     * Ollama, ...), e.g. http://llama-swap:8080/v1. Empty turns semantic search off.
     * Semantic search also needs the pgvector extension in the database.
     */
    url: env("EMBEDDING_URL", "").replace(/\/+$/, ""),
    apiKey: env("EMBEDDING_API_KEY", ""),
    model: env("EMBEDDING_MODEL", "qwen3-embedding-0.6b"),
    /**
     * Text put before search queries (not documents). Qwen3-Embedding expects an
     * instruction; models like nomic-embed use "search_query: ".
     */
    // Set-but-empty means "no prefix", so these read process.env directly.
    queryPrefix: (
      process.env.EMBEDDING_QUERY_PREFIX ??
      "Instruct: Given a search query, retrieve passages from personal documents (bills, receipts, letters, contracts) that answer it\nQuery: "
    ).replace(/\\n/g, "\n"),
    /** Text put before document chunks, e.g. "search_document: " for nomic-embed. */
    documentPrefix: (process.env.EMBEDDING_DOCUMENT_PREFIX ?? "").replace(/\\n/g, "\n"),
    chunkChars: Number(env("EMBEDDING_CHUNK_CHARS", "1500")),
    /**
     * Which documents count as a match by meaning. Similarity scales differ
     * between models, so the main cut is relative: keep documents within
     * SEMANTIC_MARGIN of the best match, and never below SEMANTIC_MIN_SIMILARITY.
     */
    minSimilarity: Number(env("SEMANTIC_MIN_SIMILARITY", "0.15")),
    margin: Number(env("SEMANTIC_MARGIN", "0.05")),
  },

};
