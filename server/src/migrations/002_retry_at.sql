-- Failed processing attempts wait before the worker picks the document up again.
alter table document add column retry_at timestamptz;
