# Performance

Light performance: transactions summarised at ingest, never kept span by span. D1 writes stay at about three rows a
transaction (its hour, its histogram bucket, the day's quota), plus an example when it's among the day's ten slowest.

- `histogram.ts`: log-scale buckets (each 1.2 times the last, 100 of them, 1 ms to about 15 min), so percentiles
  merge across hours and releases by adding counts; `percentile` answers within one bucket (±10%).
- `ingest.ts`: `summarize` (a `transaction` item: name, release, status, duration, spans as offsets with their depth,
  200 at most), `fromSpans` (a `span` item, Sentry's streamed span v2 format that the JavaScript SDKs send since v11:
  each segment span with its children in the same item becomes a transaction), `storeTransaction`, `sessionCounts`
  (a `session` update or `sessions` aggregates as counts per release and day) and `storeSessions`.
- The pages' queries are in `src/data/performance.ts`. Checked against @sentry/node 11.9.0 (span v2) and the
  transaction shape sentry-cocoa and sentry-android send (`ingest.test.ts`).
