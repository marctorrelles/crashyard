# API

What the worker answers itself, ahead of Start. Under `/api/`, outside Access, each checks its own key or
signature; `/mcp` comes after the Access check.

- `ingest.ts`: `/api/<project>/envelope/` and `/api/<project>/store/`, what the Sentry SDKs send to. In order: CORS
  (`*`, the browser SDK sends from any origin), body, envelope, key, project and key from `project_keys` (cached a
  minute per isolate, by project id and key; `projects.public_key` isn't read), a key that's off answers 403 with
  Relay's `event submission rejected with_reason: ProjectId` (from Relay's source, not seen live), the daily
  quotas, events, logs and transactions apart (`X-Sentry-Rate-Limits` by category, `error;…`, `log_item` or `transaction;span`, so SDKs stop sending
  that kind until tomorrow; 429 with `Retry-After` when nothing in the envelope can be kept), and the key's own daily
  limit on events (`<retry>:error;…:key:key_quota`, Sentry's scope and reason for a key's limit; counted in `key_days`
  per event item let in, at the request, so a retry never counts it again), then the envelope is held in R2 (`pending/`, `src/ingest/retry.ts`) and each item is processed in its own `try`
  (`processItems`, which the cron's `retryEnvelope` calls too): an `EnvelopeError` answers 400 and drops the held copy;
  any other error lists the item (`3`, or `3:2` for a span item from its third segment, so a retry doesn't count the
  first two again) and the rest goes on; the answer is 200 either way, as Relay's. The items:
  `event`, `attachment`, `feedback`, `user_report`, `log`, `check_in` and `session`/`sessions` (no quota: few, and
  they say something's alive), `transaction` and `span` (streamed spans, `span.v2`: what @sentry/node 11 sends instead
  of transactions, checked against 11.9.0; see `src/performance/`); other item types are accepted and dropped. An event without an id gets one from the held key and its index
  (`stableEventId`), the same on every try. A retry reads the project by id alone (a key turned off since doesn't lose
  what was accepted) and skips the quota (what's held was let in). The raw envelope goes
  to R2 (`envelopes/<project>/<day>/<event>`). Notices are dispatched after the response (`ctx.waitUntil`). A crash
  tagged `distribution: app_review` or `testflight` also sends `review_crash`, once per issue.
- `sentry.ts`: `/api/0/`, what sentry-cli and the build plugins call, with an auth token: chunk-upload (options,
  then gzipped chunks), `files/difs/assemble` (debug files, ProGuard), `artifactbundle/assemble` (source maps), and
  releases (kept with their commit). Assembling happens in the request, so the answer is `ok` at once. The
  organisation in the path is ignored. Commits: `repos/` answers none, so `releases set-commits` (sentry-cli 3.8,
  `--local` or not) reads the local git and PUTs the release with `commits` (id, message, author, time and each one's
  files, `patch_set`, A/M/D), newest first, which go to every project with that release (`src/data/source.ts`);
  before that it asks `previous-with-commits/` (the newest earlier release of those projects with commits, its head
  as `lastCommit`; 404 when none, so the first sends `--initial-depth` commits, 20 by default) and sends only the
  commits since.
- `mcp.ts`: `/mcp`, the MCP server (JSON-RPC over POST, answered as JSON): tools over `src/data/`. It's behind
  Access (routed after the Access check in `src/server.ts`, as the dashboard); JSON only and never cross-site, so a
  web page can't call it with someone's Access cookie. See docs/mcp.md.
