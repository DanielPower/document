# Docket

A self-hosted document archive that uses an **entity-component** model instead of fixed document types.

- **Components** are reusable groups of typed fields (`Invoice`: vendor, total, due date…). Attach any combination to a document. A component with no fields works as a tag.
- **Objects** are things that exist independently of any document: a car, a house, a person, an account. They carry components too (`Vehicle`: make, model, VIN…).
- Documents **link** to objects through `ref` fields, so the car's details live once on the car instead of being copied onto every bill.

A car repair bill is `Invoice` + `Related asset → 2019 Civic` + `Vehicle service`. A plumbing bill is `Invoice` + `Related asset → 88 Maple Crescent`. Neither duplicates any field definitions.

## How ingestion works

1. **Upload** through the web UI (drag files anywhere), or drop files into the consume folder.
2. **OCR**: [OCRmyPDF](https://ocrmypdf.readthedocs.io/) + Tesseract add a text layer to scanned pages (pages that already have text are left as they are) and produce a searchable PDF. Text is indexed in Postgres full-text search.
3. **AI proposal**: Claude reads the text (and the PDF itself for short documents), the component catalog, your existing objects, and a few similar documents you've already filed. It proposes:
   - a title and date
   - components with field values, including links to existing objects
   - **new component definitions** when nothing existing fits a reusable concept
   - **new objects** when the document concerns something not yet tracked (e.g. a car seen for the first time)
4. **Inbox**: you review the proposal next to the document preview, edit anything, and file it. New components and objects are created in the same transaction. If AI isn't configured or fails, documents still land in the inbox for manual filing.

   To change the proposal without editing it by hand, describe the change ("use an amount and a billing frequency instead of an annual amount") and choose **Revise**. The AI gets the proposal as you've edited it, plus your earlier requests for this document, and changes only what you asked about. When you edit a proposed component's fields by hand, values already filled in follow renamed fields and are converted when a field's type changes.

   **Duplicate objects.** Fields can be marked as identifiers (VIN, licence plate, account or policy number; the "ID" checkbox in the component editor). A proposed new object that shares a component and an identifier value with an existing object is that object: the document links to the existing one, and details it doesn't have yet (say, a plate) are shown as "Changes to existing objects" for you to review. Conflicting values are left alone and mentioned. This check runs when the AI proposes, every time you open an inbox document (so documents analysed in the same batch see objects filed since), and again when you file. For matches it can't prove, choose "Already have it?" on a proposed object. To clean up duplicates that already exist, use "Possible duplicates" on the Objects page, or "Merge" on an object's page. Merging moves every link to the kept object and copies over details it lacks; where both have a value, the kept object's wins.

Because filed documents are used as examples, the AI picks up your conventions as you correct it.

**Reviewing quickly.** J and K move through the inbox and Ctrl/⌘+Enter files the open document. Edits are kept while you look at other documents. After filing or deleting, the toast offers **Undo**.

**Trash.** Deleted documents go to the trash (linked from the Documents page) and are deleted for good, with their files, after 30 days. Uploading a file that's in the trash restores it.

## On your phone

Docket works in a phone's browser: the navigation moves to a bottom tab bar, the inbox and document pages stack, and search filters fold behind a **Filters** button. PDFs are drawn with PDF.js, since mobile browsers don't show a PDF inside a page.

- **Scan** opens the rear camera. Take one photo per page, reorder or remove pages, and upload them as one PDF.
- **Install** it from Chrome's menu (*Add to home screen* / *Install app*). This needs HTTPS, which a reverse proxy with a real certificate provides.
- **Share to Docket**: once installed, Docket appears in Android's share sheet. Share a PDF or image from any app, including a document scanner app with edge detection (Google Drive's scanner, for example). Files arrive at `POST /share` and open in the inbox.
- If the phone can't reach the server (e.g. off your home network without a VPN), the installed app shows a "can't reach Docket" page instead of a browser error. Nothing is cached for offline use.

## Running it

You need Postgres 13+ (for `gen_random_uuid()`) and Docker. Every push to `main` publishes an image for amd64 and arm64 to `ghcr.io/danielpower/document` (tags `latest` and `sha-<commit>`), built by `.github/workflows/docker.yml` after typecheck and tests pass. Copy `docker-compose.yml` and `.env.example` to the server; you don't need the rest of the source.

```bash
cp .env.example .env    # set DATABASE_URL and ANTHROPIC_API_KEY
```

If the package is private, log in to the registry once with a GitHub personal access token (classic) that has the `read:packages` scope:

```bash
docker login ghcr.io -u <github-username>
```

```bash
docker compose pull && docker compose up -d
```

To update, run the same command again. To pin a version, change `latest` in `docker-compose.yml` to a `sha-…` tag.

Open http://localhost:8080. Tables are created on first start (migrations live in `server/src/migrations`).

Create the database and user first if they don't exist yet, for example:

```sql
create user docket with password 'change-me';
create database docket owner docket;
```

**Backups**: your Postgres backups cover all metadata. Also back up the `./data` volume, which holds the original files, the searchable PDFs, and thumbnails.

**Authentication**: there is none built in. Put Docket behind your reverse proxy's auth (Authelia, Authentik, oauth2-proxy, Tailscale…) and don't expose it directly.

**File ownership**: the container starts as root only long enough to give `./data` and `./consume` to UID/GID 1000, then runs as that user. Set `PUID`/`PGID` in `.env` to use a different owner.

**OCR languages**: the published image includes English only. For other languages, build the image yourself (`build: .` in `docker-compose.yml`) with `--build-arg TESSERACT_LANGS="fra"`, and set `OCR_LANGUAGES=eng+fra`.

### Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string |
| `ANTHROPIC_API_KEY` | — | Enables AI proposals and component generation |
| `AI_MODEL` | `claude-opus-5-5` | Claude model |
| `AI_EFFORT` | `medium` | `low` / `medium` / `high` / `xhigh` / `max`. Lower is cheaper and faster |
| `AI_ATTACH_PDF` | `auto` | Also send the PDF (layout, tables). `auto` = documents of up to 5 pages |
| `AI_MAX_CONTENT_CHARS` | `60000` | Longer OCR text is cut, and the model is told so |
| `AI_EXAMPLE_COUNT` | `3` | Similar filed documents shown to the model |
| `OCR_LANGUAGES` | `eng` | Tesseract languages |
| `WORKER_CONCURRENCY` | `2` | Documents processed in parallel |
| `DATA_DIR` / `CONSUME_DIR` | `/data` / `/consume` | Storage and drop folder |
| `PUID` / `PGID` | `1000` | User and group the container runs as |
| `AI_ASK_MAX_STEPS` | `8` | Most searches/reads the Ask assistant makes for one question |
| `EMBEDDING_URL` | — | OpenAI-compatible embeddings API, e.g. `http://llama-swap:8080/v1`. Enables semantic search (also needs pgvector) |
| `EMBEDDING_MODEL` | `qwen3-embedding-4b` | Model name sent to that API |
| `EMBEDDING_API_KEY` | — | Sent as a bearer token, if the API needs one |
| `EMBEDDING_QUERY_PREFIX` | Qwen3 instruction | Text put before search queries. Set it empty for models without one; `search_query: ` for nomic-embed |
| `EMBEDDING_DOCUMENT_PREFIX` | empty | Text put before document chunks, e.g. `search_document: ` for nomic-embed |
| `EMBEDDING_CHUNK_CHARS` | `1500` | Size of the text chunks that get embedded |
| `SEMANTIC_MARGIN` | `0.05` | Documents within this similarity of the best match count as matches by meaning |
| `SEMANTIC_MIN_SIMILARITY` | `0.15` | Nothing below this counts. Raise it if unrelated documents show up as "similar meaning" |

## Searching

The Documents page combines:

- full-text search over title, field values, linked object names, and OCR text (`websearch` syntax: `"exact phrase"`, `-exclude`, `or`)
- **matching by meaning** (when semantic search is set up): "water damage" finds the plumber's leak repair, "car maintenance" finds oil changes. Results that match only by meaning are labelled. Keyword and meaning rankings are blended with reciprocal rank fusion, and a checkbox turns meaning off
- "has component", "linked to object" and date-range filters
- typed field filters, e.g. *Invoice › Total ≥ 500*, *Invoice › Paid is No*, *Insurance policy › End on/before 2026-01-01*

**Ask AI** (the button next to Search) turns a question like "how much do I owe on unpaid house bills this year?" into those filters, plus a total when the question asks for one (sum, average, min, max or count, optionally per year, month or linked object). It shows how it read the question. The filters it sets are ordinary filters you can adjust, and the total follows them. Totals only use exact word matching, never "similar meaning", so they don't silently include loosely related documents.

The Documents page shows cards or a **table** whose columns are fields you pick (or ones chosen from the results). **Export CSV** downloads every matching document with those columns.

The **Ask** page answers questions from the documents' contents ("when does my home insurance renew, and what's the deductible?"). Claude searches, totals and reads documents with tools, then answers with numbered links to the documents it used. Citations are checked: only documents the tools actually returned can be cited. Each question costs a few model calls, up to `AI_ASK_MAX_STEPS`.

The same filters are available over the API:

```
GET  /api/documents?q=brakes&component=invoice&where=invoice.total:gte:500&ref=<object id>&from=2025-01-01
POST /api/documents/aggregate?<same query>   {"fn": "sum", "component": "invoice", "field": "total", "groupBy": "year"}
POST /api/ai/interpret                       {"question": "..."}
POST /api/ai/ask                             {"question": "..."}
```

### Semantic search setup

Semantic search needs two things. Without them it stays off and everything else works.

1. **The pgvector extension** in Docket's database. Install the package on the Postgres server (e.g. `postgresql-18-pgvector`), then run once as a superuser, connected to Docket's database:

   ```sql
   CREATE EXTENSION vector;
   ```

   Docket creates its table of document chunks itself, sized to the embedding model.

2. **An embedding model** behind an OpenAI-compatible `/v1/embeddings` API, such as llama-swap/llama-server, Ollama, or a hosted service. Set `EMBEDDING_URL` and `EMBEDDING_MODEL`. The defaults suit Qwen3-Embedding served by llama-server with `--embedding --pooling last`.

Documents are embedded in the background after OCR, and existing documents are embedded the first time semantic search turns on. If the embeddings API is unreachable, search falls back to keywords and Docket keeps retrying. Changing `EMBEDDING_MODEL` re-embeds everything; if the new model has different dimensions, the old vectors are dropped first. The status shown by `GET /api/status` (`semantic.reason`) explains why semantic search is off.

Field values are stored in typed columns (`numeric`, `date`, `boolean`, `uuid` refs), so they're straightforward to query from SQL too. For example, maintenance spending per vehicle per year:

```sql
select car.title, extract(year from d.document_date) as year, sum(total.value_number)
from document d
join component_instance inv on inv.entity_id = d.entity_id
join component_def invd on invd.id = inv.component_id and invd.key = 'invoice'
join field_value total on total.instance_id = inv.id
join field_def tf on tf.id = total.field_id and tf.key = 'total'
join component_instance link on link.entity_id = d.entity_id
join field_value lv on lv.instance_id = link.id and lv.value_ref is not null
join entity car on car.id = lv.value_ref
join component_instance veh on veh.entity_id = car.id
join component_def vd on vd.id = veh.component_id and vd.key = 'vehicle'
group by 1, 2 order by 1, 2;
```

## Development

Requires Node 24 or newer. The server has no build step: Node runs the TypeScript sources directly using [type stripping](https://nodejs.org/api/typescript.html#type-stripping). That means the server code must use erasable TypeScript only (no `enum`, `namespace`, or constructor parameter properties), and relative imports use `.ts` extensions. `tsconfig.json` sets `erasableSyntaxOnly`, so `npm run typecheck` reports violations. `tsc` is only used for type checking.

```bash
npm install
```

```bash
cp .env.example .env    # the server scripts load ./.env when it exists
```

```bash
npm run dev --workspace server
```

```bash
npm run dev --workspace web
```

The Vite dev server proxies `/api` to `localhost:8080`. The local machine needs `ocrmypdf`, `tesseract`, and `poppler-utils` on the PATH (or set `OCRMYPDF_BIN`). Run the unit tests with `npm test`, and typecheck both workspaces with `npm run typecheck`.

`.env` is read in two places: Docker Compose passes it into the container (`env_file` in `docker-compose.yml`), and the server's npm scripts pass it to Node with `--env-file-if-exists`. Variables already set in the environment take precedence over the file.

### Layout

```
server/src/
  migrations/001_init.sql   schema: component_def, field_def, entity, document, component_instance, field_value
  services/entities.ts      loading and applying drafts (the inbox, document, and object editors all use this)
  services/ai.ts            Claude prompts, structured-output schema, validation of the model's output
  services/ocr.ts           OCRmyPDF / pdftotext / thumbnails
  services/search.ts        full-text, semantic and field filters; totals
  services/embeddings.ts    embeddings API client, pgvector table, background embedding job
  services/ai-query.ts      Ask AI (question -> filters) and the Ask assistant (tool use)
  worker.ts                 queued -> ocr -> analyzing -> inbox (uses SELECT … FOR UPDATE SKIP LOCKED; no Redis)
  shared/types.ts           types shared with the web UI
web/src/
  components/DraftEditor.tsx  the metadata editor used in the inbox, on documents, and on objects
  pages/                      Inbox, Documents (search), Ask, Objects, Components
  global.css                  CSS variables and element defaults only (no classes)
  ui.module.css               shared classes: buttons, alerts, badges, lists, page layout
  *.module.css                each component's own styles (CSS Modules)
web/scripts/check-css-modules.mjs  run by `npm run typecheck`: no classes in global.css, no literal
                                   class names, and every styles.x exists in its module
```

### Data model notes

- A **draft** (`shared/types.ts`) is the editable form of an entity's metadata: title, date, components with values, plus component definitions and objects to create. The AI outputs one; the UI edits it; `PUT /api/documents/:id/draft` applies it in one transaction.
- The AI's output is validated before it reaches the inbox. Unknown components and fields, values that don't parse for their type, and links to nonexistent objects are dropped and listed as warnings in the review panel.
- AI-proposed component definitions aren't stored until you file the document. If two inbox documents propose the same key, the second one reuses whichever was created first.
- Each AI request calls Claude with `fallbacks: "default"`, so if the model declines a document for policy reasons, the server retries on a fallback model.
