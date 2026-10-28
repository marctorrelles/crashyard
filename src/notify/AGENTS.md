# Notify

Which notifications an event causes, and sending them. Routes (in D1) pick notices by kind, project, level and
environment, each with its own thresholds, and send them to channels.

- `notice.ts`: `Notice` (kinds: `new`, `threshold`, `regression`, `ignore_expired`, `review_crash`, `monitor_down`,
  `monitor_up`, `slower_release`, `weekly`: a project's week, `frequency`, `escalating`, `metric_warning`,
  `metric_critical`, `metric_resolved`), `RouteKind` (a route picks the three metric kinds as one, `metric`, "Metric
  alert"), `routeTakes`, `thresholdFor` (a threshold notice passes a route only if one of that route's thresholds was
  crossed), `noticeLine` ("50 events in 10 minutes", "1 event in 10 minutes", `counted` for singular
  and plural, also in Notifications' route rows; "Escalating with 40 events in the last hour"; metric alerts say it in
  their culprit; a notice sent after quiet hours with `heldMore` ends "3 more arrived during quiet hours"). A route's levels and environments don't filter `weekly` nor the metric kinds (of no one
  event). `ISSUE_KINDS`, the kinds about one issue's event: a route's releases and tag filter apply to these only
  (`matchesFilters`), and its wait. A `frequency` notice carries the `routeId` whose limit it reached: only that route
  takes it. A notice's `event.tags` are the event's, for tag filters; an escalation has no one event, so it carries the
  hour's most common release, environment and level and no tags: a tag filter on another key doesn't match it, a
  negated one does.
- `rules.ts`: routes on rates. `frequencyOf` (`{ events?, users?, minutes }`, `WINDOWS` 5, 10, 30, 60, 1440),
  `windowStats` (the issue's events in the window ending at the event: `SUM(count)` of `issue_minutes` over the
  window's minutes up to the event's own, every event spike protection counted too, so exact to the minute and
  skipped when the issue's whole count is under the limit; distinct `user_hash` from `events` by `events_issue`,
  reading at most the limit plus one, so users count from the events kept, at most 60 a minute, as the form says),
  `frequencyHits` (what `noticesFor` in `src/api/ingest.ts` calls per event, so on the cron's retries too, with the
  event's own `received`): a route fires when the window's count is at the limit or over it and it hasn't fired for
  the issue within the window: `mayFire`, one upsert on `route_fires.frequency_at` (0018) with `WHERE frequency_at
<= received - window … RETURNING`, as `throttled`, so events stored at once or out of order fire once. Its own
  column, as `at` is the wait's, set by every kind; a row it inserts has `at` 0, which no wait holds. `matchesFilters`:
  release globs and a tag filter in the search's grammar (`tokenize`): `key:value`, `!`, lists, `has:`, `*` globs,
  case-sensitive; a key reads its tag, else `release`, `environment`, `level`, `os`, `device`, and also `<key>.name`
  (so `os:iOS` matches `os.name`, `os` holding the version too). `tagFilterError` refuses words, comparisons and the
  issue search's own keys (`is:`, `times:`…) on save. `throttled`: `INTERVALS` off, 10 minutes, an hour, a day; one
  upsert on `route_fires` that records the alert only when the wait has passed (`RETURNING`), so two at once can't both
  pass; per route and issue, whatever the kind.
- `metrics.ts`: metric alerts (`metric_alerts`). `METRICS`: `errors` (`event_hours`), `users` (distinct
  `events.user_hash`, exact to the window; events before 0014 have none; errors none of which name a user are
  nothing to read, so the state stays and the row says users aren't reported), `crash_free_sessions` (`sessions_daily`,
  every UTC day the window touches), `p95` (`transaction_buckets` through `percentile`), `failure_rate`
  (`transaction_hours`), `log_count` (`log_hours` when the filter is only `level`, else the logs through `logFilter`).
  Hourly tables read the window's hours and the current one, so a 1-hour window reads up to 2 hours, never less.
  Filters (`metricQueryError`): environment, release and level for errors and users; environment and release for
  sessions; release and `transaction` for transactions; the logs search for logs; never `project:`. `stateFor` compares
  strictly, critical before warning. `evaluateMetricAlerts` (the cron, every 5 minutes at :02, :07…, off the hourly jobs' minutes, within its deadline): a notice
  only on a change of state, written with `WHERE state = <the one read>` so it's sent once; nothing to read (no
  sessions, no transactions) keeps the state; the title is the alert's name, the line `metricLine`: "pocketband ·
  Crash-free sessions 97.1%, below 98% · Critical", "… 99.2% · Resolved"; crash-free is floored to a tenth.
- `channels.ts`: Telegram (`telegramRequest`: the bot's `sendMessage` to its chat, as HTML, the title in bold and
  escaped, a button opening the notice's page, the week's summary without a sound; for `ISSUE_KINDS`,
  `telegramKeyboard` adds Resolve, Ignore and Assign to me (only with an `owner`) as `callback_data` `r:<id>`, `i:`,
  `a:` (`CALLBACK`), once the channel has a `secret`, which saving it sets when `PUBLIC_URL` is https: `saveChannel`
  in `src/fns.ts` reuses the secret of any channel of the same bot (`botIdOf`; one webhook a bot), sets `owner` to
  whoever saved, then `setWebhook` to `/api/telegram/<bot id>` with `secret_token` and only `callback_query`;
  deleting the bot's last channel deletes the webhook; `telegramCall` for any method; `telegramChats`, the chats that
  wrote to the bot lately, from `getUpdates`, for the settings' Find (a bot with a webhook gets 409 there: it deletes
  the webhook and asks again, and `findTelegramChats` sets it back when the bot has a channel with a secret, as
  saving does); `server` for a local Bot API server; `telegramToken` picks
  `<bot id>:<secret>` out of what's pasted, @BotFather's whole message too; `telegramError` says what a refusal means:
  404 a token Telegram has no bot for, 401 a revoked one, 409 a bot with a webhook, a chat not found or blocked), webhooks (`json`; `slack`: Block Kit, the title in bold over its line and a button,
  `text` for the notification; `discord`: an embed coloured by level or kind, its title linking to the page,
  `allowed_mentions` empty so a title's `@everyone` pings no one; a refusal says the answer's first 200 characters),
  email. Slack, Discord, email and JSON carry an issue's actions as links (`actionUrl`, the issue's page with
  `?do=resolve|ignore|assign`: confirmed there, signed in, as mail scanners and link previews open links; Slack's as
  buttons, Discord's in the embed, email's as lines, JSON's under `actions`): an incoming webhook can't take a tap
  back, which would need a Slack or Discord app; `isQuiet` for a channel's quiet hours
  (minutes after midnight in `quiet_zone` by `Intl`, so daylight saving doesn't move them, a formatter cached per zone;
  UTC for a channel from before 0020, or a zone `Intl` doesn't know; across midnight too). No ntfy: ntfy.sh limits by IP unless the sender pays, and a Worker
  sends from IPs Cloudflare shares, so others spend its daily quota. No Bark: iPhone only. Migration 0011 took both
  channels out.
- `email.ts`: a plain-text MIME message for Cloudflare Email Routing's `send_email` binding (`EMAIL`, from
  `EMAIL_FROM`; the address it sends to must be a verified destination).
- `dispatch.ts`: `dispatch` sends each notice to its routes' channels, or holds it in `held_notifications` in quiet
  hours, after each route's wait (`throttled`) for the kinds about an issue; `flushHeld` (the cron, every minute) sends what was held as one message once they end: a `monitor_down` or
  `metric_critical` if one was held, else the newest, with `heldMore`, the others' count; its rows are taken
  (`DELETE … RETURNING`) before sending, so two runs at once send them once. A notice's channels are sent at once,
  each send timing out after 10 seconds (`SEND_TIMEOUT`, Telegram's and webhooks'). A failing channel
  is logged, written to `notification_failures` (channel, the notice's kind, the error's first 500 characters; for
  Settings, Health) and doesn't stop the others; `pruneFailures` (the hourly cron, at :20) deletes them after 30 days.

`notify.test.ts` covers routes, thresholds, frequency and metric kinds, filters, channel formats, quiet hours and the
signed links. `rules.test.ts` (the gate: 50 events in 10 minutes fire once, 365 one a day never; out of order and past spike
protection, once each; users; the wait; filters) and `metrics.test.ts` (crossing, staying, recovering, below, logs) run on `test/fakes.ts`.
