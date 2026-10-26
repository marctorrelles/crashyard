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
  `user.id` is kept only as a hash. The deployment's own field names (Settings, Data privacy, setting
  `privacy.scrub_fields`) are filtered too, in any key containing one, any case, as Sentry's additional sensitive
  fields: `loadExtraFields`, at the start of every pass (`processItems`), reads them at most once a minute per isolate,
  so a change takes up to a minute to apply.
- `event.ts`: `normalizeEvent` turns what any SDK sends into one shape (`NormalizedEvent`): title, culprit, level,
  frames (from the crashed thread when the exception has none), `threads` (every one of `threads.values`, 32 at most
  of 100 frames each, the innermost; crashed, then current, first; the thread an exception matches, by `thread_id` or
  `crashed`, keeps no frames, as its stack is the exception's; grouping reads only the exceptions; events stored
  before have none), tags (pairs or object, plus derived: level, release,
  os, device, browser, runtime, handled, mechanism), `request` (method, URL, query string, headers as pairs, body as
  text of 8 KB at most; header and query keys that name a secret are filtered as in `scrub`, query values in the URL
  too, the rest masked as tags; headers that carry the client's IP, `x-forwarded-for`, `cf-connecting-ip`,
  `forwarded` and the like (`IP_HEADERS`), are dropped and `request.env` with `REMOTE_ADDR` isn't kept, as crashyard
  stores no IPs), `extra` (scrubbed, keys in order while they fit in 16 KB of JSON) and `_trimmed`
  (what was cut: `request body`, `extra`). A `captureMessage` sends a made-up exception: `synthetic`, titled
  by its message, `type` `message`.
- `grouping.ts`: the fingerprint. Exception type + the top 5 in-app frames; a native frame without symbols is its
  image's basename + offset; an anonymous function (`?`, `<anonymous>`) is its context line, or file and line; a
  synthetic exception or a message groups by its masked text (numbers, hex, UUIDs, quoted text). A custom
  `fingerprint` wins, `{{ default }}` expands to the default.
- `store.ts`: `storeEvent` writes an event: dedupes by event id, creates the issue (`ON CONFLICT DO NOTHING
RETURNING`), then one batch for the counts, days, tags, users and activity. `transitionOf` decides a reopening: a
  resolved issue regresses on any event, or, resolved in a release, only on another release's; an ignore ends by
  count or date. Spike protection: past 60 events a minute an issue only counts, it stores no more events. A tag keeps
  100 values per issue (`TAG_VALUES`); a new one past them counts under `other` (reading at most the value's row or the
  first 100), so a search for such a value doesn't find the issue. An issue
  found with a count of 0 was made by a try whose batch then failed: the event is still its first (`isNew`, a "New
  issue" alert and the `created` activity); two first events racing may both say so. The batch also upserts
  `event_hours` (every event, kept or not) and writes `events.user_hash`. An ignore `until_users` ends on an event from a user the issue hadn't had
  (one read of `issue_users`, only then) that takes `user_count` to `ignore_until_users`; `until_escalating` never ends
  here.
- `budget.ts`: `trimEvent` (`eventJson` in `storeEvent`, just before the JSON is written; the envelope stays whole in
  R2) keeps the stored JSON under 900 KB: only an event over it is copied and cut, each cut only while still over,
  least missed first: the newest 100 breadcrumbs, 32 threads of 100 frames (crashed first), an exception's innermost
  200 frames, texts over 4 KB anywhere, then whole parts (other threads, breadcrumb data, contexts, extra, request,
  breadcrumbs, all but 20 frames, threads). `_trimmed` names each, shown under the event.
- `retry.ts`: durable ingest (docs/decisions/0004). `hold` puts the body at `pending/<project>/<received ms>-<16 hex>`
  with `customMetadata` `{ endpoint, attempts, items? }` (`items` only when some were left out, by quota or as done);
  `settle` after a pass: nothing failed deletes it, else it's rewritten with what failed and the attempts so far (the
  request is the first), and the fifth moves it to `failed/<project>/<…>` and adds 1 to `project_days.failed`.
  `retryPending` (every minute): pages through `pending/` (1000 keys a page, by `cursor`) so envelopes still in flight
  never hide older ones listed after them, and retries up to 50 older than two minutes, within 20 seconds, each through
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
`ingest.test.ts` covers each function, and client keys through `handleIngest` (on `test/fakes.ts`, the Wasm module and
`dispatch` mocked): a second key, one turned off, one past its daily limit.
