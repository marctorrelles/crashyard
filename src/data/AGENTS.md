# Data

The dashboard's SQL: plain functions that take the D1 database (and `now`), so tests and `scripts/seed.mjs` call them
directly. `src/fns.ts` wraps them as server functions; pages never import these for anything but types, constants and pure
helpers (`change`).

- `projects.ts`: the home page's overview (unresolved, events per day) and `overviewCharts` (30 UTC days, of every
  project or the page's: events per day from `project_days`, the 8 projects with the most and the rest as one; issues
  first seen per day, and how many in the last 24 hours; issues resolved per day, distinct, from `issue_activity`'s
  `resolved`, by `issue_activity_kind_at`; crash-free sessions of each project's two newest releases by their first
  session in 90 days, from `sessions_daily`; one batch of four), creating a project (slug from the name, a new key),
  changing, rotating its key, deleting (foreign keys cascade), `pruneEvents` (the daily cron: events past their
  project's retention; issues and counts stay), `dsnOf`.
- `issues.ts`: `listIssues` (a search from `src/search/`, sorted, 50 a page, with a 14-day series each), `getIssue`
  (tags' top values, the latest 100 events, the chosen event as JSON text, feedback, activity), `changeIssues`
  (resolve, now or in the next release; ignore, for good, for N events or until a date; reopen; delete; each written
  to the activity with who did it), notes, and `mergeIssues`: events, counts, days, tags, users and feedback move into
  the first issue, and the merged fingerprints go in `issue_fingerprints` so new events follow (ingest reads it).
- `releases.ts`: releases from events (kept within retention), and the release diff: new in it, came back in it,
  still happening, and gone since the release before.
- `logs.ts`: the explorer's page (newest first, cursors for older and for the live tail's newer) over a `Window`:
  a preset range up to now (the list reads on past now, for the live tail) or an exact span `from` to `to` (`to` left
  out, 90 days at most, `MAX_SPAN`); facets over the newest 1000 that match; `logsByBucket`, logs per bucket and level
  over the window (the bucket from `intervalFor`, `timestamp - timestamp % size`: `%` reads integers, whatever D1
  binds) and the span just before it, of the same length, each log shifted by the span onto the bucket it's behind,
  so `previous` lines up with the buckets, partial first bucket included; `logGroups`, logs by a field over the
  window (a column of `GROUP_COLUMNS`, level, release, environment, project, a missing one as `''`; or an attribute,
  its key bound, only the logs that have it): the 8 values with the most, each with its count in the span before (one
  read of both spans, every value's totals by a window function so the rest, value `null`, is exact), then per bucket
  a series of each (`CASE … IN` the 8, the rest as `null`); the group-by honours the whole search, its own key's
  tokens too, so it, the chart and the list count the same logs (a project grouped by its id, the slugs looked up
  after). Both read every log in the window and the span before, about two rows a log, whatever the filter: an index
  doesn't help. So for buckets of an hour or a day, a span of whole hours and a search of only `level` and `project`
  (`readsHours`; positive or negated, lists too), `logsByBucket` and `logGroups` by level or project read
  `log_hours` instead (`hourly`: each span's whole hours from it, the part-hours at its ends from the logs; two terms
  a span, as D1 allows five in a compound SELECT); the buckets and the span before line up the same. Measured on 60k
  logs over 30 days (rows_read): the 30-day chart 120,900 → 8,919, 7 days 57,029 → 4,409, a project's 30 days 40,660
  → 3,058, `level:error` 70,506 → 5,222; groups by level 241,729 → 17,788, by project 422,996 → 17,791. Any other
  search scans as before. Plan: the window by `logs_time` (a project's, `logs_project_time`), an attribute by
  `log_attributes`' primary key, temp B-trees for the groups; `log_hours` by its primary key (a project's) or
  `log_hours_hour`, the part-hours by `logs_time` (a multi-index OR). `pruneLogs` (the daily cron): logs past their
  project's retention, and the hours of `log_hours` wholly past it.
- `monitors.ts`: the monitors page (each with its last 30 results), one monitor's history and incidents, making,
  changing, pausing (a resumed one starts again from pending) and deleting; failing monitors for home.
- `performance.ts`: transactions over 1, 7 or 30 days by p95 (percentiles merged from the hourly histograms) with the
  change since the release before and `trend`, the p95 of each step (an hour in a day, 6 hours in a week, a day in 30;
  from the same read of `transaction_buckets`, grouped by the step too) (the project's two newest releases with
  transactions); one transaction's hours, releases and slowest examples; sessions per release and `crashFree`;
  `checkSlowerReleases` (the cron, hourly at :05: a p95 50% longer in the newest release than the one before, 50
  transactions in each at least, told once via `slower_releases`); `prunePerformance` (the daily cron: summaries after
  90 days, examples after 30).
- `updates.ts`: whether a newer crashyard is out, from the repo's latest GitHub release, asked once a day through
  the Cache API, for home's banner; nothing about the deployment is sent.
- `suggest.ts`: the search bar's keys and values from what's stored. Issues: tag keys by how many issues have them, a
  key's values by events (`issue_tag_values`, index `issue_tag_values_key_value`), `type`, `platform` and the release
  columns from `issues`, `project` from the projects; logs: attribute keys and values, `release` and `environment`,
  counted over the newest 5000 logs in the range. Enums, numbers, times, `has:`, `trace` and words are the bar's own (no
  SQL). Values start with the prefix (`LIKE`, case-insensitive, its `%` `_` `\` escaped by `likePrefix`, tested); keys
  `LIMIT 50`, values `LIMIT 20`. Plans (`EXPLAIN QUERY PLAN`, seeded local DB): tag keys scan the covering index
  `issue_tag_values_key_value` (a project's: its issues by `issues_project_last_seen`, their tags by primary key); a
  tag's values search that index by key; the release columns search `issues_project_last_seen` by project; log keys and
  values search `log_attributes` by primary key (`log_id`, and `key`) for the sample, which reads `logs_time` (a
  project's, `logs_project_time`).
- `charts.ts`: `intervalFor` (a minute up to an hour, 5 minutes up to 6 hours, an hour up to a week, else a day),
  `buckets` (UTC bucket starts for `1m`, `5m`, `1h`, `1d`), `topWithOther` (the n series with most, the rest summed
  bucket by bucket as `null`), `change` (now against before as a fraction, `null` when before was 0), `fill` (sparse
  rows, a day or a bucket's start with a level and count, as a series per level, zeros where none, most severe first,
  logs' `warn` and `trace` among them), `scoped` (an issue filter narrowed to the page's project and to its `project:`
  slugs: `listIssues` uses it too, so the chart and the list count the same issues) and `issueEventsByDay` (events per
  UTC day and level, or project with `by` (grouped by id, the slugs looked up after: `slugsOf`), of the issues a search
  matches, from `issue_days`). Plan: the issues by the filter (a scan, or a project's by `issues_project_last_seen`),
  then each one's days by `issue_days`' primary key; with no filter, the days by `issue_days_day`.
- `dashboards.ts`: dashboards (`dashboards`, one row each, its widgets as JSON, who saved it last) and their widgets.
  `parseWidgets` checks what the browser sends field by field: 20 at most, ids 8 hex digits and unique, a title (80), a
  query (1000), a dataset (`issues`, `events`, `logs`) and a display it has (`DISPLAYS`: issues as a number or a list;
  events and logs as a number, bars, area, line or a table), a width of 1 to 3 thirds and a group-by (60, a field name;
  events by `level` or `project`, `EVENT_GROUPS`; logs a column or an attribute, which `logGroups` only binds; none for
  issues); keys that aren't a widget's are dropped, and a placeholder (`invalid`) is refused. `readWidgets` reads the
  stored ones one by one: a widget that no longer checks out (or text that isn't JSON or a list) becomes a placeholder
  in its place, `invalid` holding why, with an id free (as is a repeated one's), so the dashboard opens and it can be
  removed or redone; `listDashboards` counts widgets only of valid JSON (else `null`). `widgetData` reads one widget
  through the lists' own functions and turns any error into `{ kind: 'error' }` (a placeholder's is its reason, without
  a read). Logs: `logsByBucket` (by level), `logGroups` (a group-by, and the table, by level when none). Events come
  from `issue_days`, so they're whole UTC days (`eventDays`): a number or table counts every day the window touches (24
  hours: yesterday and today) against as many days before; a chart shows those days, a week at least, 90 at most. Issues
  are as they are now, the window doesn't narrow them (`lastSeen:-24h` in the query does): a number counts the matching
  ones against those of them first seen before the window began, a list the 10 with most events. `STARTER` is the
  "Crashes" dashboard. Plan: the list by `dashboards_updated`; a dashboard by its primary key.
- `source.ts`: stacks linked to the code. `storeCommits` (a release's commits from set-commits, its head as the
  release's `ref`, and `source_files`, every path the commits sent so far left: added or changed, not deleted since);
  `previousWithCommits`; `releaseCommits` (each linked to the project's `repo_url`); `frameLinks`, each in-app frame of
  an event matched to a file (`matchFile`: the file whose path ends with the most of the frame's, from its absolute
  path, its file, or for Java and Kotlin its package's folders and file; none on a tie) at the release's commit, else
  `HEAD`; `codeUrl` and `commitUrl` for GitHub and GitLab (by host); `repoUrl` checks what's typed.
- `notifications.ts`: channels and routes, and `testRoute`, which sends a made-up notice through a route's channels
  now and says how each went.

Keep anything a browser page imports (constants, types) free of `cloudflare:*` imports: they'd break the client build.
