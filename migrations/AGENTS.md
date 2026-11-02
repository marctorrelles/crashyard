# Migrations

D1 (SQLite) migrations, applied in order by `wrangler d1 migrations apply DB` (`--local` for dev and CI, `--remote`
in `pnpm run deploy`, on the built config `-c dist/server/wrangler.json`, so a database `wrangler.local.json` renames
is the one migrated; its `migrations_dir` is rewritten to `../../migrations` there).

- Never edit a migration that's been deployed: add the next number.
- Only add (tables, columns with defaults, indexes): the worker before an upgrade must still run on the upgraded
  database, so rolling a deploy back is safe (`docs/upgrading.md`). A migration that can't be written so is called out
  in the changelog with what to do.
- Times are milliseconds since 1970 (`INTEGER`), days are `YYYY-MM-DD` in UTC, lists and objects are JSON text.
- Every table a page lists from has the index it sorts by; say what a column holds in a comment beside it.
- `dashboards.widgets` is JSON that `parseWidgets` (`src/data/widgets.ts`) checks before it's written, and
  `readWidgets` again one widget at a time when it's read: a change to a widget's shape keeps reading the rows already
  stored, and one that no longer checks out shows as a placeholder to remove.
- `issues_fts` is FTS5 over issue titles and culprits, kept in step by triggers.
- D1's free tier writes 100,000 rows a day; an event writes about 30 (event, tags, counts, days). Keep new per-event
  writes few; 0014 adds one, the `event_hours` upsert. A batch of logs writes about 2 + attributes rows a log, plus a `log_hours` row for each project, hour and
  level in it and one `project_days` row.
- `log_hours` is logs per project, hour and level, written at ingest (`storeLogs`) and pruned with the logs; 0009
  filled it from the logs there were. The logs chart reads it rather than every log (`src/data/AGENTS.md`).
- 0012: `project_days.failed` (envelopes that failed every retry) and `filtered` (inbound filters);
  `attachments.received`, from its event's time for the rows there were (0 when the event is gone, so they're pruned),
  indexed for pruning. A worker from before 0012 writes attachments with `received` 0: pruned at the next hour.
- 0013: `settings` and `preferences` (JSON values, `src/data/settings.ts`); `project_keys`, a project's client keys,
  filled with each project's `public_key` as its "Default" key, and a trigger (`projects_default_key`) gives every
  new project its first key from `public_key`, whoever inserts it (`projects.public_key` stays, unread by ingest, so a
  worker from before still takes that key), and `key_days` (events per key and UTC day); `notification_failures`;
  `tokens.project_id` (null: every project, as before); `projects.auto_resolve_days` (null: off).
- 0014: `event_hours` (events per issue, hour, level, release and environment, `''` for none, as WITHOUT ROWID keys
  can't be null; one upsert in `storeEvent`'s batch, every event spike protection counts too; filled from the events
  kept, one `INSERT … SELECT … GROUP BY`; pruned with the events), `events.user_hash` (null before), routes'
  `frequency`, `releases`, `query` and `interval_minutes`, `route_fires`, `metric_alerts` (its last `value` too, for the
  list), `issues.priority` (filled from the level: fatal high, error medium, the rest low), `issues.ignore_until_users`,
  `issues_escalating` (partial), `projects.priorities` (null: by level). A worker from before 0014 writes no
  `event_hours` and new issues get `medium`.
- 0015: `dashboards.revisions` (JSON, the widget lists of the last 10 saves, newest first, `'[]'` for the rows there
  were) and `saved_searches` (a person's named search per page, pinned, shared; `saved_searches_page`). Widgets stay
  as stored: v1 rows are upgraded on read and written as v2 on their next save. A worker from before 0015 reads a v2
  widget as a placeholder, so rolling back shows saved v2 dashboards as widgets to redo, the data untouched.
- 0016: `commit_files` (each set-commits commit's paths and A, M or D, for suspect commits), `projects.grouping_rules`,
  `grouping_version` (1), `grouping_previous` and `grouping_until` (src/ingest/AGENTS.md), `projects.filters` (JSON,
  null for none), `events.grouping_version` and `events.fingerprint` (the hash before any merge, null before 0016;
  `events_issue_fingerprint` for unmerge), `discarded_fingerprints`, `issues.assignee`, `external_url`,
  `resolved_in_commit` and `fixed_in_release` (resolved in that release: it and newer releases reopen it),
  `issues_assignee` (partial), `bookmarks` and `issue_views` (by email). Every column is nullable or has a default, so
  a worker from before 0016 runs as it did: it writes events without a fingerprint and ignores the rest.
- 0017: sessions and release health in one file. `session_users_daily` (a session's `did` per release, environment and UTC day, as
  `didHash`, salted with the project; `crashed` is the max of the day's sessions; one upsert per session update with a
  `did`, so retries count no one twice), `deploys`, `vital_buckets` (as `transaction_buckets`, by vital too: ms, CLS
  times 1000, frame rates in hundredths of a percent), `monitor_environments`, `check_ins.trace_id`
  (`check_ins_trace`), `monitors.muted_at`, `projects.release_crash_free_min` and `release_new_issues_max`. Nothing is
  backfilled: sessions before it have no users, transactions no vitals. Every column is nullable, so a worker from
  before 0017 runs as it did.
- 0018: `issue_minutes` (every event of an issue per minute, kept or only counted, for frequency routes' windows; one
  upsert in `storeEvent`'s batch, so an event writes one more row; pruned after a day by `pruneEvents`, no index on
  `minute` as the table holds about a day; no backfill, so windows open just after it count from then) and
  `route_fires.frequency_at` (when the route's frequency last fired for the issue). A worker from before 0018 writes no
  `issue_minutes` and fires as it did.
- 0019: `attachments_event_key`, unique on `(event_id, r2_key)`, after deleting the rows a whole-envelope retry had
  copied (the oldest of each kept; they shared one R2 object), the one delete in a migration. Attachments are keyed
  by their item index from then on. A worker from before 0019 that retries a whole envelope with an attachment hits
  the index on that item, which then fails each try and ends in `failed/`; its event and other items are stored.
- 0020: `channels.quiet_zone` (the IANA zone of a channel's quiet hours; null for the rows there were, which stay in
  UTC). A worker from before 0020 reads a zoned channel's quiet hours as UTC.
- 0021: `events.user_keys` (a hash per user field, `src/search/user.ts`; null for the events there were, still found by
  `user_hash`). No new rows per event: a column of the row already written.
- 0022: crashyard's own sign-in (`src/auth/AGENTS.md`): `users` (email unique, lowercased; role; `github_id`),
  `passkeys`, `sessions` (by the cookie's SHA-256, `sessions_expires` for pruning), `challenges`, `invites`,
  `recovery_codes` and `user_tokens`, every secret as its SHA-256. New tables only: a worker from before ignores them.
- 0023: `pending_spans`, streamed spans that came before their segment, held until it comes (`src/performance/`) and
  pruned after a day. A new table: a worker from before ignores it and drops those spans, as it did.
- 0024: `projects.workers` (JSON, Cloudflare Workers by script name, for `src/api/tail.ts`; null for none) and
  `worker_exceptions` (0). A worker from before has no `tail()` handler: runs sent to it are dropped.
- 0025: `monitors.public` (0), an uptime check on its project's status page. A worker from before has no status page.
- 0026: `sentry_imports`, each Sentry issue imported into a project and the issue it became, so importing again
  skips it. A new table: a worker from before ignores it.
- 0027: `status_posts` (a project's incidents, notices and maintenance, `impact`; maintenance has its window) and
  `status_updates` (each post's updates, `state`, the markdown message and who posted it). New tables: a worker from
  before shows no posts.
- 0028: `status_post_monitors` (the uptime checks a post affects), `projects.status_page` (JSON, the page's look) and
  `projects.status_domain` (unique when set, `projects_status_domain`). A worker from before ignores them.
- 0029: `projects.forward_dsn`, a Sentry DSN every envelope the project accepts goes on to (`src/ingest/forward.ts`),
  null for none. A worker from before ignores it.
- 0030: status pages of their own. `status_pages` (`slug` and `domain` unique, `branding` JSON) and
  `status_page_monitors` (any uptime check, on any number of pages); each project with a page (a look, a domain, a
  check shown or a post) carried over under its slug and name, its checks with `public` on. `status_posts`,
  `status_updates` and `status_post_monitors` made again with the same ids, posts by `page_id` instead of
  `project_id`, the old tables dropped children first so nothing cascades, the new renamed (SQLite rewrites the
  foreign keys). `projects.status_page`, `projects.status_domain` and `monitors.public` dropped. A worker from before
  fails on status pages until the deploy finishes.
- `0031_events_received.sql`: `events_received`, so Explore over every project reads its window of events by
  `received` instead of scanning them all.
- `0032_session_crashes.sql`: `session_crashes`, a crashed session's id (`sid`) when first counted, so a crash
  counts once a session (the browser SDK sends an `unhandled` session again); and `sessions_daily.crashed` cut to
  `started` where double counts had taken it past (crash-free read below 0%).
- `0033_push.sql`: `push_devices`, each person's devices with push on, by email as preferences are (endpoint unique,
  the browser's `p256dh` and `auth`, a name, when last sent to), and `users_push_delete`, a trigger taking someone's
  devices and push channel with them when they're removed.
- `0034_sent_notifications.sql`: `sent_notifications`, each notice a route sent (its `payload`, and `deliveries`, what
  each channel did with it by channel id: sent, held or failed with the error), by `at`, pruned after 30 days; and
  `held_notifications.sent_id`, the row a held send settles once quiet hours end. A worker from before writes neither,
  so Notifications lists nothing it sent.
- `0036_actions.sql`: `actions`, product analytics (`src/ingest/actions.ts`): one row an action, `user_hash` as
  `events.user_hash` so the two join, `platform`, `os`, `device`, `browser`, `country`, `properties` JSON; indexed
  by name, by user (partial) and by trace (partial), so an action writes three rows. `projects.action_retention_days`
  (365), and `funnels` (a project's saved funnels, steps as JSON). New tables and a column with a default: a worker
  from before stores actions as ordinary logs and ignores the rest.
- `0035_artifact_cache_ranges.sql`: `artifact_files.cache_offset` and `cache_length`, a file's SourceMapCache as a range
  of its bundle's one packed object; null on older rows, whose `cache_key` is the whole object. A worker from before
  reads a new row's whole packed object as one cache, so its JavaScript frames stay unmapped until the deploy finishes.
