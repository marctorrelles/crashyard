# Migrations

D1 (SQLite) migrations, applied in order by `wrangler d1 migrations apply DB` (`--local` for dev and CI, `--remote`
in `pnpm run deploy`).

- Never edit a migration that's been deployed: add the next number.
- Only add (tables, columns with defaults, indexes): the worker before an upgrade must still run on the upgraded
  database, so rolling a deploy back is safe (`docs/upgrading.md`). A migration that can't be written so is called out
  in the changelog with what to do.
- Times are milliseconds since 1970 (`INTEGER`), days are `YYYY-MM-DD` in UTC, lists and objects are JSON text.
- Every table a page lists from has the index it sorts by; say what a column holds in a comment beside it.
- `issues_fts` is FTS5 over issue titles and culprits, kept in step by triggers.
- D1's free tier writes 100,000 rows a day; an event writes about 30 (event, tags, counts, days). Keep new per-event
  writes few.
