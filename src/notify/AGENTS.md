# Notify

Which notifications an event causes, and sending them. Routes (in D1) pick notices by kind, project, level and
environment, each with its own thresholds, and send them to channels.

- `notice.ts`: `Notice` (kinds: `new`, `threshold`, `regression`, `ignore_expired`, `review_crash`, `monitor_down`,
  `monitor_up`, `slower_release`, `weekly`: a project's week, which a route's levels and environments don't filter),
  `routeTakes`,
  `thresholdFor` (a threshold notice passes a route only if one of that route's thresholds was crossed), `noticeLine`.
- `channels.ts`: Telegram (`telegramRequest`: the bot's `sendMessage` to its chat, as HTML, the title in bold and
  escaped, a button opening the notice's page, the week's summary without a sound; `telegramChats`, the chats that
  wrote to the bot lately, from `getUpdates`, for the settings' Find; `server` for a local Bot API server; `telegramToken` picks
  `<bot id>:<secret>` out of what's pasted, @BotFather's whole message too; `telegramError` says what a refusal means:
  404 a token Telegram has no bot for, 401 a revoked one, 409 a bot with a webhook, a chat not found or blocked), webhooks (`json`; `slack`: Block Kit, the title in bold over its line and a button,
  `text` for the notification; `discord`: an embed coloured by level or kind, its title linking to the page,
  `allowed_mentions` empty so a title's `@everyone` pings no one; a refusal says the answer's first 200 characters),
  email; `isQuiet` for a channel's quiet hours
  (minutes after midnight UTC, across midnight too). No ntfy: ntfy.sh limits by IP unless the sender pays, and a Worker
  sends from IPs Cloudflare shares, so others spend its daily quota. No Bark: iPhone only. Migration 0011 took both
  channels out.
- `email.ts`: a plain-text MIME message for Cloudflare Email Routing's `send_email` binding (`EMAIL`, from
  `EMAIL_FROM`; the address it sends to must be a verified destination).
- `dispatch.ts`: `dispatch` sends each notice to its routes' channels, or holds it in `held_notifications` in quiet
  hours; `flushHeld` (the cron, every minute) sends what was held as one message once they end. A failing channel
  is logged, written to `notification_failures` (channel, the notice's kind, the error's first 500 characters; for
  Settings, Health) and doesn't stop the others; `pruneFailures` (the hourly cron, at :20) deletes them after 30 days.

`notify.test.ts` covers routes, thresholds, channel formats, quiet hours and the signed links.
