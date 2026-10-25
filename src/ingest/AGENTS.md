# Ingest

What happens to an event between the SDK and D1. Pure functions, except `store.ts`. `src/api/ingest.ts` calls them in
order.

- `body.ts`: `readBody` reads the request, gunzipped or inflated, up to 20 MB (`BodyError` carries the status).
- `envelope.ts`: `parseEnvelope` splits a Sentry envelope (header line, then item header + payload, by `length` or up
  to the newline). `payloadJson` parses an item.
- `auth.ts`: `projectKey` finds the DSN key: `X-Sentry-Auth` `sentry_key=`, `?sentry_key=`, `Authorization`, or the
  envelope header's `dsn`.
- `scrub.ts`: before anything is stored. Values under secret-looking keys become `[Filtered]`; emails, card numbers
  and bearer tokens in text are masked. `user.id` is kept only as a hash.
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
  count or date. Spike protection: past 60 events a minute an issue only counts, it stores no more events.

Checked against `@sentry/node` 11.9 (the e2e test) and GlitchTip's incoming event fixtures (`test/fixtures`).
`ingest.test.ts` covers each function.
