import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./db.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  await sql`create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())`;
  const dir = path.join(here, "migrations");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migration`).map((r) => r.name));
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = await fs.readFile(path.join(dir, file), "utf8");
    await sql.begin(async (tx) => {
      // Serialize concurrent migrators (e.g. two containers starting at once).
      await tx`select pg_advisory_xact_lock(4242)`;
      const [done] = await tx`select 1 from schema_migration where name = ${file}`;
      if (done) return;
      await tx.unsafe(text);
      await tx`insert into schema_migration (name) values (${file})`;
    });
    console.log(`applied migration ${file}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => sql.end()).catch((err) => { console.error(err); process.exit(1); });
}
