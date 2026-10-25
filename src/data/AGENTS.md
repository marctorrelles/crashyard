# Data

The dashboard's SQL: plain functions that take the D1 database (and `now`), so tests and `scripts/seed.mjs` call them
directly. `src/fns.ts` wraps them as server functions; pages never import these for anything but types and constants.

- `projects.ts`: the home page's overview (unresolved, events per day), creating a project (slug from the name, a new
  key), changing, rotating its key, deleting (foreign keys cascade), `pruneEvents` (the daily cron: events past their
  project's retention; issues and counts stay), `dsnOf`.
- `issues.ts`: `listIssues` (a search from `src/search/`, sorted, 50 a page, with a 14-day series each), `getIssue`
  (tags' top values, the latest 100 events, the chosen event as JSON text, feedback, activity), `changeIssues`
  (resolve, now or in the next release; ignore, for good, for N events or until a date; reopen; delete; each written
  to the activity with who did it), notes, and `mergeIssues`: events, counts, days, tags, users and feedback move into
  the first issue, and the merged fingerprints go in `issue_fingerprints` so new events follow (ingest reads it).
- `releases.ts`: releases from events (kept within retention), and the release diff: new in it, came back in it,
  still happening, and gone since the release before.
- `logs.ts`: the explorer's page (newest first, a time range, cursors for older and for the live tail's newer),
  facets over the newest 1000 that match, `pruneLogs` (the daily cron).
- `monitors.ts`: the monitors page (each with its last 30 results), one monitor's history and incidents, making,
  changing, pausing (a resumed one starts again from pending) and deleting; failing monitors for home.
- `performance.ts`: transactions over 1, 7 or 30 days by p95 (percentiles merged from the hourly histograms) with the
  change since the release before (the project's two newest releases with transactions); one transaction's hours,
  releases and slowest examples; sessions per release and `crashFree`; `checkSlowerReleases` (the cron, hourly at
  :05: a p95 50% longer in the newest release than the one before, 50 transactions in each at least, told once via
  `slower_releases`); `prunePerformance` (the daily cron: summaries after 90 days, examples after 30).
- `updates.ts`: whether a newer crashyard is out, from the repo's latest GitHub release, asked once a day through
  the Cache API, for home's banner; nothing about the deployment is sent.
- `notifications.ts`: channels and routes, and `testRoute`, which sends a made-up notice through a route's channels
  now and says how each went.

Keep anything a browser page imports (constants, types) free of `cloudflare:*` imports: they'd break the client build.
