# API

What the worker answers itself, ahead of Start. Under `/api/`, outside Access, each checks its own key or
signature; `/mcp` comes after the Access check.

- `ingest.ts`: `/api/<project>/envelope/` and `/api/<project>/store/`, what the Sentry SDKs send to. In order: CORS
  (`*`, the browser SDK sends from any origin), body, envelope, key, project (cached a minute per isolate), the daily
  quotas, events, logs and transactions apart (`X-Sentry-Rate-Limits` by category, `error;…`, `log_item` or `transaction;span`, so SDKs stop sending
  that kind until tomorrow; 429 with `Retry-After` when nothing in the envelope can be kept), then each item:
  `event`, `attachment`, `feedback`, `user_report`, `log`, `check_in` and `session`/`sessions` (no quota: few, and
  they say something's alive), `transaction` and `span` (streamed spans, `span.v2`: what @sentry/node 11 sends instead
  of transactions, checked against 11.9.0; see `src/performance/`); other item types are accepted and dropped. The raw envelope goes
  to R2 (`envelopes/<project>/<day>/<event>`). Notices are dispatched after the response (`ctx.waitUntil`). A crash
  tagged `distribution: app_review` or `testflight` also sends `review_crash`, once per issue.
- `sentry.ts`: `/api/0/`, what sentry-cli and the build plugins call, with an auth token: chunk-upload (options,
  then gzipped chunks), `files/difs/assemble` (debug files, ProGuard), `artifactbundle/assemble` (source maps), and
  releases (kept with their commit). Assembling happens in the request, so the answer is `ok` at once. The
  organisation in the path is ignored.
- `mcp.ts`: `/mcp`, the MCP server (JSON-RPC over POST, answered as JSON): tools over `src/data/`. It's behind
  Access (routed after the Access check in `src/server.ts`, as the dashboard); JSON only and never cross-site, so a
  web page can't call it with someone's Access cookie. See docs/mcp.md.
- `actions.ts`: `POST /api/actions/<issue>/<resolve|ignore>`, the buttons on a push, checked by `verifyAction`.
