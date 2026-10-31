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

Because filed documents are used as examples, the AI picks up your conventions as you correct it.

## Running it

You need Postgres 13+ (for `gen_random_uuid()`) and Docker.

```bash
cp .env.example .env    # set DATABASE_URL and ANTHROPIC_API_KEY
```

```bash
docker compose up -d --build
```

Open http://localhost:8080. Tables are created on first start (migrations live in `server/src/migrations`).

Create the database and user first if they don't exist yet, for example:

```sql
create user docket with password 'change-me';
create database docket owner docket;
```

**Backups**: your Postgres backups cover all metadata. Also back up the `./data` volume, which holds the original files, the searchable PDFs, and thumbnails.

**Authentication**: there is none built in. Put Docket behind your reverse proxy's auth (Authelia, Authentik, oauth2-proxy, Tailscale…) and don't expose it directly.

**OCR languages**: set `OCR_LANGUAGES=eng+fra` and build with `--build-arg TESSERACT_LANGS="fra"`.

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

## Searching

The Documents page combines:

- full-text search over title, field values, linked object names, and OCR text (`websearch` syntax: `"exact phrase"`, `-exclude`, `or`)
- "has component" filters
- "linked to object" filters
- typed field filters, e.g. *Invoice › Total ≥ 500*, *Invoice › Paid is No*, *Insurance policy › End on/before 2026-01-01*

The same filters are available over the API:

```
GET /api/documents?q=brakes&component=invoice&where=invoice.total:gte:500&ref=<object id>
```

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

```bash
npm install
```

```bash
DATABASE_URL=postgres://localhost/docket npm run dev --workspace server
```

```bash
npm run dev --workspace web
```

The Vite dev server proxies `/api` to `localhost:8080`. The local machine needs `ocrmypdf`, `tesseract`, and `poppler-utils` on the PATH (or set `OCRMYPDF_BIN`). Run the unit tests with `npm test --workspace server`, and typecheck both workspaces with `npm run typecheck`.

### Layout

```
server/src/
  migrations/001_init.sql   schema: component_def, field_def, entity, document, component_instance, field_value
  services/entities.ts      loading and applying drafts (the inbox, document, and object editors all use this)
  services/ai.ts            Claude prompts, structured-output schema, validation of the model's output
  services/ocr.ts           OCRmyPDF / pdftotext / thumbnails
  services/search.ts        full-text and field filters
  worker.ts                 queued -> ocr -> analyzing -> inbox (uses SELECT … FOR UPDATE SKIP LOCKED; no Redis)
  shared/types.ts           types shared with the web UI
web/src/
  components/DraftEditor.tsx  the metadata editor used in the inbox, on documents, and on objects
  pages/                      Inbox, Documents (search), Objects, Components
```

### Data model notes

- A **draft** (`shared/types.ts`) is the editable form of an entity's metadata: title, date, components with values, plus component definitions and objects to create. The AI outputs one; the UI edits it; `PUT /api/documents/:id/draft` applies it in one transaction.
- The AI's output is validated before it reaches the inbox. Unknown components and fields, values that don't parse for their type, and links to nonexistent objects are dropped and listed as warnings in the review panel.
- AI-proposed component definitions aren't stored until you file the document. If two inbox documents propose the same key, the second one reuses whichever was created first.
- Each AI request calls Claude with `fallbacks: "default"`, so if the model declines a document for policy reasons, the server retries on a fallback model.
