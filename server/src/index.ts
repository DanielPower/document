import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { HttpError } from "./errors.ts";
import { migrate } from "./migrate.ts";
import { apiRoutes } from "./routes/api.ts";
import { startConsumeWatcher } from "./services/ingest.ts";
import { checkOcrTools } from "./services/ocr.ts";
import { startWorker } from "./worker.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  await migrate();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 10 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 100 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.status(500).send({ error: "Internal error" });
  });

  await app.register(apiRoutes);

  // Serve the built web UI (single-page app) when present.
  const webDist = process.env.WEB_DIST ?? path.resolve(here, "../../web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  const log = (m: string) => app.log.info(m);
  if (config.runWorker) {
    for (const problem of await checkOcrTools()) {
      app.log.warn(`OCR will fail until this is fixed: ${problem}`);
    }
    startWorker(log);
    startConsumeWatcher(log);
  }

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
