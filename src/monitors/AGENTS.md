# Monitors

Cron monitors (jobs that check in, Sentry's way) and uptime checks (URLs the worker asks), with incidents.

- `schedule.ts`: Sentry's schedules: a crontab in a time zone (wall-clock, so daylight saving is right; when both
  day fields are restricted, either matches, as cron does) or an interval. `nextRun`, tested in `schedule.test.ts`.
- `monitors.ts`:
  - `recordCheckIn`: a `check_in` envelope item. The first one with a `monitor_config` makes the monitor (as Sentry
    does; without a config, a check-in for an unknown slug is dropped). `in_progress` only moves when the next one
    is due; `ok` and `error` are results.
  - `runMonitors`, every minute from the cron: cron monitors whose check-in is late (the next run plus the margin)
    get a `missed` check-in; runs in progress past `maxRuntime` (30 minutes by default) time out; uptime checks
    that are due run (`check`: status, or any 2xx; text it must contain; a timeout).
  - `afterResult`: failures and successes in a row against the monitor's thresholds (Sentry's
    `failure_issue_threshold`, `recovery_threshold`; uptime checks default to two failures). Crossing one opens or
    closes an incident and sends `monitor_down` or `monitor_up` through the routes.
  - Links in those notices use `PUBLIC_URL` (wrangler.jsonc): the cron has no request to take an origin from.
  - `pruneMonitors`: uptime results after 30 days, check-ins after 90.

`monitors.test.ts` covers the thresholds and the checks; the ingest end-to-end test checks in with the real SDK
and runs the cron through `/__dev/cron`.
