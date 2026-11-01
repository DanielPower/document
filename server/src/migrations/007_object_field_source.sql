-- Which document last set a field on an object (a licence plate learned from a
-- registration, say), so the object page can say where each detail came from.
-- The value is kept as it was set: once someone changes the field, the source
-- no longer describes it and isn't shown.
create table object_field_source (
  object_id   uuid not null references entity(id) on delete cascade,
  component   text not null,
  field       text not null,
  document_id uuid not null references entity(id) on delete cascade,
  value       jsonb not null,
  set_at      timestamptz not null default now(),
  primary key (object_id, component, field)
);
create index object_field_source_document_idx on object_field_source(document_id);
