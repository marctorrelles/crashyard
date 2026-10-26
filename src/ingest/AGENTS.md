# Ingest

What happens to an event between the SDK and D1. Pure functions, except `store.ts`. `src/api/ingest.ts` calls them in
order.

- `body.ts`: `readBody` reads the request, gunzipped or inflated, up to 20 MB (`BodyError` carries the status).
- `envelope.ts`: `parseEnvelope` splits a Sentry envelope (header line, then item header + payload, by `length` or up
  to the newline). `payloadJson` parses an item.
- `auth.ts`: `projectKey` finds the DSN key: `X-Sentry-Auth` `sentry_key=`, `?sentry_key=`, `Authorization`, or the
  envelope header's `dsn`.
- `scrub.ts`: before anything is stored. Values under secret-looking keys become `[Filtered]`; emails, card numbers
  and bearer tokens in text are masked (an email's domain ends in letters, so a release like `app@1.2.0` stays).
  `user.id` is kept only as a hash.
- `event.ts`: `normalizeEvent` turns what any SDK sends into one shape (`NormalizedEvent`): title, culprit, level,
  frames (from the crashed thread when the exception has none), tags (pairs or object, plus derived: level, release,
  os, device, browser, runtime, handled, mechanism). A `captureMessage` sends a made-up exception: `synthetic`, titled
  by its message, `type` `message`.
- `grouping.ts`: the fingerprint. Exception type + the top 5 in-app frames; a native frame without symbols is its
  image's basename + offset; an anonymous function (`?`, `<anonymous>`) is its context line, or file and line; a
  synthetic exception or a message groups by its masked text (numbers, hex, UUIDs, quoted text). A custom
  `fingerprint` wins, `{{ default }}` expands to the default.
- `store.ts`: `storeEvent` writes an event: dedupes by event id, creates the issue (`ON CONFLICT DO NOTHING
RETURNING`), then one batch for the counts, days, tags, users and activity. `transitionOf` decides a reopening: a
  resolved issue regresses on any event, or, resolved in a release, only on another release's; an ignore ends by
  count or date. Spike protection: past 60 events a minute an issue only counts, it stores no more events. An issue
  found with a count of 0 was made by a try whose batch then failed: the event is still its first (`isNew`, a "New
  issue" alert and the `created` activity); two first events racing may both say so.
- `retry.ts`: durable ingest (docs/decisions/0004). `hold` puts the body at `pending/<project>/<received ms>-<16 hex>`
  with `customMetadata` `{ endpoint, attempts, items? }` (`items` only when some were left out, by quota or as done);
  `settle` after a pass: nothing failed deletes it, else it's rewritten with what failed and the attempts so far (the
  request is the first), and the fifth moves it to `failed/<project>/<…>` and adds 1 to `project_days.failed`.
  `retryPending` (every minute): up to 50 keys of `pending/` older than two minutes, within 20 seconds, each through
  `retryEnvelope` (`src/api/ingest.ts`; injectable for `retry.test.ts`, which uses `test/fakes.ts`); a pass that
  throws counts as everything failing. A worker stopped mid-envelope leaves its first metadata, so every item is tried
  again: events dedupe by id, logs and transactions already counted count again.

- `logs.ts`: Sentry's structured logs (a `log` item: `{ items: [...] }`, typed attributes). Keeps release,
  environment and trace id from the attributes; drops `user.*` (the SDK adds the scope's user, email included).
  `storeLogs` writes each log, then its own (not `sentry.*`) attributes, up to 16, into `log_attributes` with
  `last_insert_rowid()` (that table is WITHOUT ROWID, so the id stays the log's), and adds the batch to `log_hours`
  (an upsert for each hour and level in it) and `project_days`, in one batch. About 2 + attributes rows a log, plus one
  for each hour and level.

Checked against `@sentry/node` 11.9 (the e2e test) and GlitchTip's incoming event fixtures (`test/fixtures`).
`ingest.test.ts` covers each function.
