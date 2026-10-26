# Migrations

D1 (SQLite) migrations, applied in order by `wrangler d1 migrations apply DB` (`--local` for dev and CI, `--remote`
in `pnpm run deploy`).

- Never edit a migration that's been deployed: add the next number.
- Only add (tables, columns with defaults, indexes): the worker before an upgrade must still run on the upgraded
  database, so rolling a deploy back is safe (`docs/upgrading.md`). A migration that can't be written so is called out
  in the changelog with what to do.
- Times are milliseconds since 1970 (`INTEGER`), days are `YYYY-MM-DD` in UTC, lists and objects are JSON text.
- Every table a page lists from has the index it sorts by; say what a column holds in a comment beside it.
- `dashboards.widgets` is JSON that `parseWidgets` (`src/data/dashboards.ts`) checks before it's written, and
  `readWidgets` again one widget at a time when it's read: a change to a widget's shape keeps reading the rows already
  stored, and one that no longer checks out shows as a placeholder to remove.
- `issues_fts` is FTS5 over issue titles and culprits, kept in step by triggers.
- D1's free tier writes 100,000 rows a day; an event writes about 30 (event, tags, counts, days). Keep new per-event
  writes few. A batch of logs writes about 2 + attributes rows a log, plus a `log_hours` row for each project, hour and
  level in it and one `project_days` row.
- `log_hours` is logs per project, hour and level, written at ingest (`storeLogs`) and pruned with the logs; 0009
  filled it from the logs there were. The logs chart reads it rather than every log (`src/data/AGENTS.md`).
- 0012: `project_days.failed` (envelopes that failed every retry) and `filtered` (inbound filters, phase 5);
  `attachments.received`, from its event's time for the rows there were (0 when the event is gone, so they're pruned),
  indexed for pruning. A worker from before 0012 writes attachments with `received` 0: pruned at the next hour.
- 0013: `settings` and `preferences` (JSON values, `src/data/settings.ts`); `project_keys`, a project's client keys,
  filled with each project's `public_key` as its "Default" key, and a trigger (`projects_default_key`) gives every
  new project its first key from `public_key`, whoever inserts it (`projects.public_key` stays, unread by ingest, so a
  worker from before still takes that key), and `key_days` (events per key and UTC day); `notification_failures`;
  `tokens.project_id` (null: every project, as before); `projects.auto_resolve_days` (null: off).
