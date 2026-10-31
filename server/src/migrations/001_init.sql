-- Docket: an entity-component document store.
--
-- Everything you can attach metadata to is an *entity*: documents (files) and
-- objects (things that exist on their own: a car, a house, a person).
-- Metadata lives in *components*: named, reusable groups of typed fields.
-- An entity can carry any number of components. A component with no fields
-- works as a tag.

create table component_def (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  name        text not null,
  description text not null default '',
  -- Extra guidance for the AI on when to attach this component.
  ai_hint     text not null default '',
  color       text not null default '#6b7280',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table field_def (
  id           uuid primary key default gen_random_uuid(),
  component_id uuid not null references component_def(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label        text not null,
  type         text not null check (type in ('text','longtext','number','money','date','boolean','select','ref')),
  description  text not null default '',
  required     boolean not null default false,
  -- select: {"choices": [...]}; money: {"currency": "CAD"};
  -- ref: {"component": "<component key the target must carry>"} (optional)
  options      jsonb not null default '{}'::jsonb,
  position     int not null default 0,
  unique (component_id, key)
);
create index field_def_component_idx on field_def(component_id, position);

create table entity (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('document','object')),
  title      text not null default '',
  notes      text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index entity_kind_idx on entity(kind);

create table document (
  entity_id         uuid primary key references entity(id) on delete cascade,
  -- queued -> ocr -> analyzing -> inbox -> filed ; any step may go to failed
  status            text not null default 'queued'
                    check (status in ('queued','ocr','analyzing','inbox','filed','failed')),
  original_filename text not null,
  mime_type         text not null,
  file_size         bigint not null,
  sha256            text not null unique,
  original_path     text not null,
  archive_path      text,          -- searchable PDF produced by OCR
  thumb_path        text,
  page_count        int,
  content           text not null default '',
  document_date     date,
  proposal          jsonb,         -- AI draft awaiting review in the inbox
  error             text,
  attempts          int not null default 0,
  locked_at         timestamptz,
  added_at          timestamptz not null default now(),
  search            tsvector
);
create index document_status_idx on document(status, added_at);
create index document_search_idx on document using gin(search);
create index document_date_idx on document(document_date);

create table component_instance (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id) on delete cascade,
  component_id uuid not null references component_def(id) on delete restrict,
  position     int not null default 0,
  created_at   timestamptz not null default now()
);
create index component_instance_entity_idx on component_instance(entity_id);
create index component_instance_component_idx on component_instance(component_id);

-- Typed value columns keep values queryable (sums, ranges, joins on refs).
create table field_value (
  instance_id  uuid not null references component_instance(id) on delete cascade,
  field_id     uuid not null references field_def(id) on delete cascade,
  value_text   text,
  value_number numeric,
  value_date   date,
  value_bool   boolean,
  value_ref    uuid references entity(id) on delete set null,
  primary key (instance_id, field_id)
);
create index field_value_field_idx on field_value(field_id);
create index field_value_ref_idx on field_value(value_ref) where value_ref is not null;
create index field_value_number_idx on field_value(field_id, value_number) where value_number is not null;
create index field_value_date_idx on field_value(field_id, value_date) where value_date is not null;

-- Rebuilds the full-text vector for one document: title (A), component field
-- text plus referenced object titles (B), OCR content (C).
create or replace function refresh_document_search(doc uuid) returns void
language sql as $$
  update document d set search =
      setweight(to_tsvector('simple', coalesce(e.title, '')), 'A')
   || setweight(to_tsvector('english', coalesce((
        select string_agg(concat_ws(' ', cd.name, fv.value_text, fv.value_number::text, re.title), ' ')
        from component_instance ci
        join component_def cd on cd.id = ci.component_id
        left join field_value fv on fv.instance_id = ci.id
        left join entity re on re.id = fv.value_ref
        where ci.entity_id = d.entity_id), '')), 'B')
   || setweight(to_tsvector('english', coalesce(d.content, '')), 'C')
  from entity e
  where e.id = d.entity_id and d.entity_id = doc;
$$;

-- Wake the worker as soon as there is work.
create or replace function notify_document_queued() returns trigger
language plpgsql as $$
begin
  if new.status = 'queued' then
    perform pg_notify('docket_jobs', new.entity_id::text);
  end if;
  return new;
end $$;

create trigger document_queued
  after insert or update of status on document
  for each row execute function notify_document_queued();

-- Starter components. Edit or delete them freely.
with c as (
  insert into component_def (key, name, description, ai_hint, color) values
    ('invoice', 'Invoice', 'A bill or receipt for goods or services.', 'Attach to any bill, invoice or receipt that shows an amount owed or paid.', '#2563eb'),
    ('vehicle', 'Vehicle', 'A car, truck, motorcycle or other vehicle.', 'Usually belongs on an object (the vehicle itself), not on documents.', '#dc2626'),
    ('property', 'Property', 'A home or other real estate.', 'Usually belongs on an object (the property itself), not on documents.', '#16a34a'),
    ('asset_link', 'Related asset', 'Links a document to the thing it concerns (a vehicle, a property, ...).', 'Attach when a document concerns a specific vehicle, property or other owned thing; point it at the matching object.', '#9333ea')
  returning id, key
)
insert into field_def (component_id, key, label, type, options, position, required)
select c.id, f.key, f.label, f.type, f.options::jsonb, f.position, f.required
from c join (values
  ('invoice', 'vendor', 'Vendor', 'text', '{}', 0, true),
  ('invoice', 'invoice_number', 'Invoice number', 'text', '{}', 1, false),
  ('invoice', 'total', 'Total', 'money', '{"currency":"CAD"}', 2, true),
  ('invoice', 'tax', 'Tax', 'money', '{"currency":"CAD"}', 3, false),
  ('invoice', 'due_date', 'Due date', 'date', '{}', 4, false),
  ('invoice', 'paid', 'Paid', 'boolean', '{}', 5, false),
  ('vehicle', 'make', 'Make', 'text', '{}', 0, false),
  ('vehicle', 'model', 'Model', 'text', '{}', 1, false),
  ('vehicle', 'year', 'Year', 'number', '{}', 2, false),
  ('vehicle', 'vin', 'VIN', 'text', '{}', 3, false),
  ('vehicle', 'plate', 'Licence plate', 'text', '{}', 4, false),
  ('property', 'address', 'Address', 'longtext', '{}', 0, false),
  ('asset_link', 'asset', 'Asset', 'ref', '{}', 0, true)
) as f(component_key, key, label, type, options, position, required) on f.component_key = c.key;
