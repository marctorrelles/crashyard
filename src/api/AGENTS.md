# API

What the worker answers under `/api/`, outside Access: `src/server.ts` routes these before Start, and each checks
its own key or signature.

- `ingest.ts`: `/api/<project>/envelope/` and `/api/<project>/store/`, what the Sentry SDKs send to. In order: CORS
  (`*`, the browser SDK sends from any origin), body, envelope, key, project (cached a minute per isolate), the daily
  quota (429 with `Retry-After` and `X-Sentry-Rate-Limits`, as Sentry answers, so SDKs back off), then each item:
  `event`, `attachment`, `feedback`, `user_report`; other item types are accepted and dropped. The raw envelope goes
  to R2 (`envelopes/<project>/<day>/<event>`). Notices are dispatched after the response (`ctx.waitUntil`). A crash
  tagged `distribution: app_review` or `testflight` also sends `review_crash`, once per issue.
- `actions.ts`: `POST /api/actions/<issue>/<resolve|ignore>`, the buttons on a push, checked by `verifyAction`.
