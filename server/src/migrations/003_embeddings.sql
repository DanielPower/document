-- Which embedding model the document's chunks were last embedded with (null = not yet).
-- The chunk table itself is created at runtime, because it needs the pgvector
-- extension, which may not be installed.
alter table document add column embedded_model text;
