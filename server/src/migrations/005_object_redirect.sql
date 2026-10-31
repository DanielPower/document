-- When an object is merged into another, references to the old id (e.g. in
-- inbox proposals written before the merge) are resolved through this table.
create table object_redirect (
  old_id     uuid primary key,
  new_id     uuid not null references entity(id) on delete cascade,
  merged_at  timestamptz not null default now()
);
