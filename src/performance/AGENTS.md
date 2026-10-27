# Performance

Light performance: transactions summarised at ingest, never kept span by span. D1 writes stay at about three rows a
transaction (its hour, its histogram bucket, the day's quota), plus an example when it's among the day's ten slowest,
plus a row per vital it measured (a browser page load about five, an app start one to six).

- `histogram.ts`: log-scale buckets (each 1.2 times the last, 100 of them, 1 ms to about 15 min), so percentiles
  merge across hours and releases by adding counts; `percentile` answers within one bucket (±10%).
- `ingest.ts`: `summarize` (a `transaction` item: name, release, status, duration, spans as offsets with their depth in tree order, siblings by the start as sent, finer than the millisecond kept, so a
  child stays under its parent when both start in the same millisecond, as sentry-rust lists spans as they finish,
  200 at most), `fromSpans` (a `span` item, Sentry's streamed span v2 format that the JavaScript SDKs send since v11 and
  sentry-dart since 10: each segment span with its children, from the item and those held, becomes a transaction; a
  span sent twice counts once), `spanTransactions` (around it: an SDK sends spans as they finish, a batch every few
  seconds, so a segment longer than that comes after its children; those are held in `pending_spans`, one row a span,
  `INSERT OR IGNORE` so a retry holds none twice, and read into their segment's transaction; `release` deletes them
  once it's stored; `prunePerformance` drops what's held after a day; a child ending after its segment stays held until
  then), `storeTransaction`, `sessionCounts`
  (a `session` update or `sessions` aggregates as counts per release and day; the browser SDK's `unhandled` is a crash;
  each with its `did`, trimmed, 200 characters, none when empty; an update that changes no count still names its user)
  and `storeSessions` (the counts, and per `did` an upsert into `session_users_daily` of `didHash`, SHA-256 of
  `session:<project>:<did>`, 32 hex, so the id is never stored and the same id in two projects differs; `issue_users`
  hashes user ids unsalted, this salts with the project).
- `vitals.ts`: `VITALS` (label, `short` for a card, the web vitals by their initials, web or mobile, unit, the scale it's stored at, Sentry's thresholds), `vitalsOf` (a
  transaction's `measurements`, `{ value, unit }`, seconds, microseconds and nanoseconds read as ms: `lcp`, `inp`,
  `cls`, `fcp`, `ttfb`, `app_start_cold`, `app_start_warm`, `time_to_initial_display`, `time_to_full_display`, and
  `frames_slow` and `frames_frozen` over `frames_total` as rates in percent; stored times `scale`, whole, so CLS is
  kept in thousandths and rates in hundredths of a percent, in the buckets of `histogram.ts`; `summarize` returns them
  as `vitals`, `storeTransaction` upserts each into `vital_buckets`), `fromStored`, `rate` (good up to `good`, needs
  improvement up to `poor`, poor past it). Thresholds: web from Sentry's performance score,
  `static/app/views/insights/browser/webVitals/utils/scoreThresholds.tsx` on master 2026-10-27 (good is
  `PERFORMANCE_SCORE_P90S`: LCP 1200, FCP 900, INP 200, CLS 0.1, TTFB 200; poor past `PERFORMANCE_SCORE_MEDIANS`:
  2400, 1600, 500, 0.25, 400), the desktop table of its Web Vitals docs; mobile app starts from its Mobile Vitals docs
  (cold good under 3 s, poor past 5 s; warm 1 s and 2 s); TTID poor past 2 s from
  `static/app/utils/performance/vitals/constants.tsx`, its only threshold, so good up to it with no middle; TTFD and
  the frame rates have none, shown unrated. Streamed spans (`fromSpans`) carry no `measurements`, so @sentry/browser
  11 with span streaming on sends no vitals here yet. `vitals.test.ts`, with p75 through `src/data/performance.ts`.
- The pages' queries are in `src/data/performance.ts`. Checked against @sentry/node 11.9.0 and sentry-dart 10.2.0 (span v2,
  the segment 7 s after its children) and the
  transaction shape sentry-cocoa and sentry-android send (`ingest.test.ts`).
