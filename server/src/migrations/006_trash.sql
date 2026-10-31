-- Deleted documents go to the trash first and are purged after 30 days.
-- trashed_from remembers the status to restore (inbox or filed).
alter table document drop constraint document_status_check;
alter table document add constraint document_status_check
  check (status in ('queued','ocr','analyzing','inbox','filed','failed','trashed'));
alter table document add column trashed_at timestamptz;
alter table document add column trashed_from text;
