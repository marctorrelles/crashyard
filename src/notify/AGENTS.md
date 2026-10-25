# Notify

Which notifications an event causes, and sending them. Routes (in D1) pick notices by kind, project, level and
environment, each with its own thresholds, and send them to channels.

- `notice.ts`: `Notice` (kinds: `new`, `threshold`, `regression`, `ignore_expired`, `review_crash`), `routeTakes`,
  `thresholdFor` (a threshold notice passes a route only if one of that route's thresholds was crossed), `noticeLine`.
- `channels.ts`: ntfy (`Title`, `Click`, `Tags`, `Priority`, `Actions` headers), webhooks (`json`, `slack`,
  `discord`), email; `isQuiet` for a channel's quiet hours (minutes after midnight UTC, across midnight too).
- `email.ts`: a plain-text MIME message for Cloudflare Email Routing's `send_email` binding (`EMAIL`, from
  `EMAIL_FROM`; the address it sends to must be a verified destination).
- `dispatch.ts`: `dispatch` sends each notice to its routes' channels, or holds it in `held_notifications` in quiet
  hours; `flushHeld` (the cron, every minute) sends what was held as one message once they end. A failing channel
  is logged and doesn't stop the others.
- `actions.ts`: the Resolve and Ignore buttons on a push: links signed with HMAC-SHA-256 (`ACTION_SECRET`, a worker
  secret), for one issue and one action, valid a week.

`notify.test.ts` covers routes, thresholds, channel formats, quiet hours and the signed links.
