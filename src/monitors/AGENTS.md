# Monitors

Cron monitors (jobs that check in, Sentry's way) and uptime checks (URLs the worker asks), with incidents.

- `schedule.ts`: Sentry's schedules: a crontab in a time zone (wall-clock, so daylight saving is right; when both
  day fields are restricted, either matches, as cron does) or an interval. `nextRun`, tested in `schedule.test.ts`.
- `monitors.ts`:
  - `recordCheckIn`: a `check_in` envelope item, from an SDK or over HTTP (`src/api/ingest.ts`). The first one with a
    `monitor_config` makes the monitor (as Sentry does; without a config, a check-in for an unknown slug is dropped),
    up to `MAX_CRON_MONITORS` (200) a project, never over an uptime check of the same slug (its upsert updates only a
    cron row, so a DSN can't fake an outage on a status page); a check-in id another monitor already has is left as
    it is.
    `in_progress` only moves when the next one is due; `ok` and `error` are results. A check-in without an id, or
    Relay's nil id (an HTTP one that named none), finishes the monitor's latest run in progress, as Sentry pairs
    them, else it's its own with the caller's `fallbackId`; finishing a run fills its release and environment when it
    had none. The run it finishes is the latest in progress started by `now`, or one with `finished = now`: a retry
    comes with the same `now` (its envelope's received time), so it finds the run its first try finished, or the
    check-in of its own it wrote, and updates it instead of writing another.
    Each check-in keeps its trace (`contexts.trace.trace_id`, which `captureCheckIn` sends from the scope) and sets
    its environment's row in `monitor_environments` (in_progress, ok, or failing for an error; the monitor's own
    environment when it names none).
  - Errors during a job (`getMonitor` in `src/data/monitors.ts`): checked in @sentry/core 11.9.0
    (`build/esm/monitor.js`, `server-runtime-client.js`): `withMonitor` puts no monitor slug on events, it runs the
    callback in an isolation scope that keeps the propagation context, so its errors and both of its check-ins share
    one trace id, and `captureCheckIn` sends that trace as `contexts.trace`. So an error is the job's when it shares a
    check-in's trace, or, for SDKs that set it, when its `contexts.monitor.slug` names the monitor (the `monitor.slug`
    tag `normalizeEvent` derives).
  - Muting: a monitor with an incident open for 14 days (`MUTE_AFTER`) gets `muted_at` from `runMonitors`; `apply`
    sends no `monitor_down` while it's set, and recovery clears it and still sends `monitor_up`, as Sentry's crons
    mute and unmute. Resuming a paused monitor clears it too.
  - `runMonitors`, every minute from the cron: cron monitors whose check-in is late (the next run plus the margin)
    get a `missed` check-in; runs in progress past `maxRuntime` (30 minutes by default) time out; uptime checks
    that are due run, five at a time (`UPTIME_AT_ONCE`: a Worker keeps 6 connections open and queues the rest, and a
    check's timer starts with its request), until the cron's deadline, what's left staying due for the next minute
    (`check`: the method of `UPTIME_METHODS`, the config's headers, a body only for POST, PUT and
    PATCH, `BODY_METHODS`, and a `sentry-trace` header of a new trace, unsampled, as Sentry's uptime checks send; then
    status, or any 2xx, unless a status assertion stands in for it; text it must contain, in the first 1 MB read; `assertions`: a status
    among some, a header containing a value, a JSON path, `atPath` `$.a.b[0]`, whose value, a string or else its JSON,
    equals one; the first that fails is the error; a timeout). Headers, body and assertions live in `config`, beside
    the method and status, not in columns of their own.
  - `afterResult`: failures and successes in a row against the monitor's thresholds (Sentry's
    `failure_issue_threshold`, `recovery_threshold`; uptime checks default to two failures). Crossing one opens or
    closes an incident and sends `monitor_down` or `monitor_up` through the routes.
  - Links in those notices use `PUBLIC_URL` (wrangler.jsonc): the cron has no request to take an origin from.
  - `pruneMonitors` (the hourly cron): uptime results after 30 days, check-ins after 90.

`monitors.test.ts` covers the thresholds and the checks; the ingest end-to-end test checks in with the real SDK
and runs the cron through `/__dev/cron`.
