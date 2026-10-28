# Data

The dashboard's SQL: plain functions that take the D1 database (and `now`), so tests and `scripts/seed.mjs` call them
directly. `src/fns.ts` wraps them as server functions; pages never import these for anything but types, constants and pure
helpers (`change`).

- `projects.ts`: the home page's overview (unresolved, events per day) and `overviewCharts` (30 UTC days or `n`, of every
  project or the page's: events per day from `project_days`, the 8 projects with the most and the rest as one; issues
  first seen per day, and how many in the last 24 hours; issues resolved per day, distinct, from `issue_activity`'s
  `resolved`, by `issue_activity_kind_at`; crash-free sessions of each project's two newest releases by their first
  session in 90 days, from `sessions_daily`; one batch of four); `overview`'s `newest`, each project's newest release
  with sessions in the last 24 hours (today and yesterday, by its first session day) and its share of them, creating a project (slug from the name, a new key,
  in `project_keys` too by 0013's trigger, the limits and retention of `projectDefaults`), changing, its client keys
  (`keysOf` with today's events from `key_days`, `createKey`, `updateKey`: label, on or off, daily limit),
  `updateProject` (only the fields given, of `PROJECT_FIELDS`, `grouping_rules` and the release thresholds among them, checked in `fns.ts`; a slug another project has throws), deleting (foreign keys cascade), `pruneEvents` (the hourly cron, at :15: events past
  their project's retention, then attachments past it, rows and R2 objects, by `attachments.received`, then issues last
  seen before it with all their rows by cascade, 100 a batch; events and attachments 1000 a batch; each in a loop until
  a batch deletes nothing or the deadline, the cron's shared one (`PRUNE_BUDGET`, 20 s, when called alone); `inBatches`;
  `retention.test.ts` prunes 12,000 of each in one run, on `test/fakes.ts`; then `event_hours` past retention and an
  hour, 1000 a batch, then `issue_minutes` past a day, then
  `session_users_daily` past the event retention, 1000 a batch each), `dsnOf` (a project id and a key), `seenWorkers` (the `tail.workers` setting, newest run first, each
  Worker with the projects whose `workers` list it, for Connect an app), `filteredSince` (what the filters dropped in the last N UTC days, for Settings,
  Filters), `weeklySummaries` (the cron, Mondays at 07:00 UTC: a
  `weekly` notice per project with events in the 7 UTC days to yesterday or the 7 before: its events against the week
  before, new issues, the issue with the most, and the crash-free sessions of its newest release in the week, floored to
  a tenth so a crash never reads 100%; one batch of four).
- `issues.ts`: `listIssues` (a search from `src/search/`, with the viewer for `assigned:me`, `is:bookmarked` and
  `is:unread`, sorted, 50 a page, with a 14-day series each and the viewer's `bookmarked` and `unread`), `getIssue`
  (the project's releases with events, newest first, 50, for the release picker; tags' top values, the latest 100 events, the chosen event as JSON text, its attachments with whether each is an
  image, `attachmentType`, feedback, activity), `changeIssues`
  (resolve, now, in the next release, in the current release (`current`: each issue's `last_release`, read first so
  the activity names it) or in a chosen one (`release`), the last two as `fixed_in_release`; ignore, for good, for N events or until a date; reopen; delete, and with
  `discard` first every fingerprint of the issues, their own and those merged into them, into
  `discarded_fingerprints`, so ingest drops their events as filtered; each written to the
  activity with who did it), notes, and `mergeIssues`: events, counts, days, tags, users and feedback move into
  the first issue, and the merged fingerprints go in `issue_fingerprints` so new events follow (ingest reads it).
  `autoResolve` (the hourly cron, at :20): unresolved issues of a project with `auto_resolve_days`, last seen before
  that many days, resolved 100 a batch with an `auto_resolved` activity entry (`{ days }`), within the cron's deadline; the
  overview's resolved per day counts only `resolved`, what a person did. Ignoring takes `untilEscalating`
  (`until_escalating`, the default in the UI: only escalation opens it) and `forUsers` (`ignore_until_users`, the user
  count that ends it, as `ignore_until_count`); `priority` sets `issues.priority` with a `priority` activity entry;
  `SORTS.priority` is high first, then the most recently seen. A merge adds the merged issues' `event_hours` into the
  first. `assignees` (the viewer, then every email in `issue_activity.by` or assigned already, 100 at most), `assignIssue`
  (an email or null, with an `assigned` entry `{ assignee }`), `bookmarkIssue` and `isBookmarked` (`bookmarks`, by
  email), `markViewed` (`issue_views`, an upsert, from `getIssue`'s server function for a person, not an agent),
  `linkIssue` (`external_url`, http or https as `fns.ts` checks, with a `linked` entry `{ url }`). `getIssue`'s
  `merged` counts its `issue_fingerprints`. `mergedFingerprints` lists them with their kept events
  (by `events.fingerprint`, `events_issue_fingerprint`), the newest's first line as a title and its top in-app frame (`topFrame`, nearest the crash, else the nearest,
  `function (file:line)`), first and last seen; `unmergeIssue` moves one
  out: a new issue with that fingerprint (title, culprit and level from its newest event, the source's priority,
  `ongoing`), its events and their feedback, then days, `event_hours`, tags and users rebuilt from the moved events
  and taken off the source (rows at 0 deleted; a user stays on the source while it has events of theirs), both
  issues' counts and the new one's first and last seen and releases from its events, the fingerprint out of
  `issue_fingerprints`, an `unmerged` entry on the source and `unmerged_from` on the new one; one batch. Only kept
  events move: what spike protection only counted, or retention pruned, stays counted on the source. A fingerprint
  with no events kept just leaves `issue_fingerprints` (answers null), so its next event opens a new issue. Events
  stored before 0016 have no fingerprint: both first hash the issue's with version 1 and no rules, as ingest did then,
  and write it (`backfillFingerprints`: only `json_extract` of what grouping reads, exceptions, fingerprint, message
  and title, never the whole `data`, 200 a batch, looping until none are left or its deadline; one it can't read is
  marked `''` and stays). The list, a GET that writes derived data only, loops 5 seconds; the unmerge 20, and when
  that isn't enough it moves nothing and says it's only partly done, to unmerge again, which goes on from there.
- `escalation.ts`: `escalating(hours)`: the last of a week of hourly counts plus the hour just ended escalates with 10
  events or more (`MIN_EVENTS`) and more than twice (`FACTOR`) the busiest hour before it, so steady traffic, however
  busy, and its usual peaks don't. `checkEscalation` (the cron, hourly at :25, within its deadline): the hour just ended's
  issues with 10 or more in `event_hours` (by `event_hours_hour`), unresolved and not escalating, or ignored
  `until_escalating`, first seen over a day ago (a younger one is still new), 500 at most, 50 a batch: their 168 hours
  before from `event_hours`; those that escalate get `escalating` (an ignored one opens), an `escalating` activity
  entry (`{ count, hour, wasIgnored }`) and an `escalating` notice with the hour's most common release, environment
  and level. Escalating issues with no `escalating` entry in 7 days go back to `ongoing` first (index
  `issues_escalating`). `escalation.test.ts` on `test/fakes.ts`.
- `releases.ts`: releases from events (kept within retention) and from sessions (a release with sessions and no events
  is one too, its first and last seen the start of its first and last session days), newest first, and the release
  diff: new in it, came back in it, still happening, and gone since the release before. `releaseHealth`: each
  release's sessions and crashed, users and crashed users (`session_users_daily`, distinct hashes over every day and
  environment), crash-free sessions and users (1 minus crashed over all), and over the last 24 hours, read as the UTC
  days it spans, today and yesterday (sessions are only counted per day): its sessions, active users and adoption,
  its share of those sessions. `adoptionStage`: adopted from 10% (`ADOPTED`), else replaced when a release first seen
  after it has more of the sessions, else low adoption. `adoptionByDay` (30 UTC days, null on a day with no
  sessions), `healthOf` (a project's `release_crash_free_min` and `release_new_issues_max`: healthy when each set
  one holds, `failed` naming the others; null when none is set or can be judged, crash-free needing sessions),
  `deploysOf` (50, newest first) and `storeDeploy`. `releases.test.ts` on `test/fakes.ts`.
- `logs.ts`: `conditions` (a search's SQL over `logs l`, narrowed to a project, exported for `widgets.ts` and
  `export.ts`); the explorer's page (newest first, cursors for older and for the live tail's newer) over a `Window`:
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
  `log_hours_hour`, the part-hours by `logs_time` (a multi-index OR). `pruneLogs` (the hourly cron, in the same
  budget): logs past their project's retention, 1000 a batch until done, and the hours of `log_hours` wholly past it.
- `status.ts`: status pages (0030), each with the uptime checks it picks from any projects. `statusPage` (no sign-in:
  the checks in `status_page_monitors`, each with its project's name, its state, 30 UTC days, incidents, and the
  posts; never a URL, why a check failed or who posted; null when it shows nothing, as for no such page) and the
  posts: `IMPACTS` (minor, major, notice, maintenance), `STATES_FOR` (an
  incident's investigating, identified, monitoring, resolved; a notice's or maintenance's update, resolved, shown as
  Completed for maintenance, `stateLabel`), `createPost` (the post and its first update), `addUpdate` (resolved
  closes it, any other state opens it again), `deletePost`, `postsOf` (open, or ended in 30 days, newest first, each
  with `phase`: open, upcoming, ongoing, past; maintenance ends at `ends_at` unless resolved first, and `affects`, the
  checks it names, 0028), `checksOf` (every project's uptime checks, by project, `shown` on this page), `pagesOf`
  (every page for Monitors, Status pages: its domain, the checks shown, the posts not ended), `pageOf`,
  `pagesShowing` (the pages a check is on, for its monitor page), `createPage` (its slug `slugify` of the name, `-2`,
  `-3`… while taken), `updatePage` (name, slug, branding, domain; a slug or domain another page has refused),
  `setCheck` (uptime checks only), `deletePage` (its posts with it). A post's checks are only checks on its page (an
  `INSERT … SELECT`); an update with `monitors` replaces them. `statusPage` names only the checks on the page, gives
  each check `affected` (the worst open post naming it: major, minor, then ongoing maintenance) and the page's
  `branding` (`parseBranding`: title, description, logo, color, website). `slugOfDomain`: the page whose `domain` a
  hostname is, all of them read at most once a minute per isolate, for `src/server.ts`. `status.test.ts`: only chosen
  checks, nothing of their URLs or errors, the posts' phases, no poster's email, affected checks, branding, domains,
  checks of several projects and on several pages, slugs.
- `monitors.ts`: the monitors page (each with its last 30 results), one monitor's history and incidents (with
  `uptime`, the share of results that passed, or of finished runs that were ok, over 24 hours, 7 and 30 days, null
  with none; `p95`, `p95Series` nearest rank, per hour over 24 hours for an uptime check's response times, per day
  over 30 days for a job's durations; `environments`; `errors`, the newest 20 events naming its slug in the
  `monitor.slug` tag, by `event_tags_lookup`, or in the trace of one of its last 200 check-ins, by `events_trace`),
  making, changing, pausing (a resumed one starts again from pending, unmuted; pausing or resuming closes its open incident, which only failing closes otherwise) and deleting; failing monitors for home.
- `performance.ts`: transactions over 1, 7 or 30 days by p95 (percentiles merged from the hourly histograms) with the
  change since the release before and `trend`, the p95 of each step (an hour in a day, 6 hours in a week, a day in 30;
  from the same read of `transaction_buckets`, grouped by the step too) (the project's two newest releases with
  transactions); one transaction's hours, releases and slowest examples (sessions are `releases.ts`'); `vitals`, a
  project's or one transaction's vitals over the period from `vital_buckets`: p75 of each measured, its rating, and its
  change from the release before to the newest (the same two releases);
  `checkSlowerReleases` (the cron, hourly at :05: a p95 50% longer in the newest release than the one before, 50
  transactions in each at least, told once via `slower_releases`); `prunePerformance` (the hourly cron: summaries after
  90 days, vital buckets too, examples after 30, held spans after a day).
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
- `explore.ts`: Explore. `whereOf` (a search through `eventFilter` over a window, `all` for every event kept, the
  page's project, an issue, `project:` slugs; every value bound, `explore.test.ts` checks none reaches the SQL),
  `exploreEvents` (the newest 50 with `older`, the cursor of the next page by `received`; columns: `level`,
  `release`, `environment`, `project` or a tag's value, 6 at most, `DEFAULT_COLUMNS` when none), `exploreChart` (count
  or `count_unique(user)`, distinct `user_hash` per bucket, per bucket of `intervalFor` the range; with `groupBy`, a
  built-in or a tag, the 10 biggest values, `GROUPS`, each a series, events without the tag in none), `traceOf` (a
  trace's events with their issue and project, 200, by `events_trace`; its logs, 500, by `logs_trace`; its stored
  transaction examples with their spans, 20). Plans: the window by `events_project` for a project, else a scan of the
  window's events; tags by `event_tags`' primary key. `explore.test.ts` on `test/fakes.ts`.
- `widgets.ts`: dashboard widgets, schema v2 (`Widget`): a dataset (`DATASETS`: issues, events, logs, transactions,
  sessions, monitors, releases, markdown), a display it has (`DISPLAYS`; markdown is `text`), 1 to 3 queries
  (`MAX_QUERIES`) each a search, an aggregate and a label (40), up to 2 group-by fields (`GROUPS`; logs also any
  attribute, only ever bound), a sort (by value or name, up or down), a limit of groups or issues shown (1 to 50, 8
  unset), thresholds for a number (warning, critical, above or below), or markdown text (4000), and a width.
  `aggregateError` refuses what a dataset can't compute with a sentence naming what it can: issues count; events count
  and `count_unique(user)` (null, not reported, when a bucket's events name no user, so it never reads 0 users); logs count and avg, sum, min, max, p50, p75, p95, p99 of a numeric attribute; transactions
  count, `failure_rate` and avg or a percentile of `duration`; sessions count and `crash_free_rate`; monitors count,
  `uptime`, `failure_rate` and any function of `duration`; releases count, users and crash-free rate. Transactions
  also take p50 to p99 of a vital (`p75(lcp)`, `vital_buckets` through `percentile`, divided by the vital's scale,
  `Source.scale`; in ms, percent, or a number for CLS), and sessions `crash_free_users` (`session_users_daily`, 100
  minus distinct crashed hashes over distinct hashes, so a user counts once however many days). `uptime` is ours,
  beyond the plan's list: 100 minus the failure rate. Transactions, sessions, monitors and releases take filters of
  fixed keys only (`FILTER_KEYS`, checked on save like metric alerts). `upgradeWidget` turns the first shape (one
  `query`, a count, a `groupBy` string) into v2: its query a count, its group-by a list of one; `parseWidget` upgrades
  any widget without `queries` before checking, so stored v1 rows and v1 JSON from an old tab read the same.
  `readWidgets` as before: one widget at a time, a placeholder for one that doesn't check out. `widgetData`: issues as
  before (a count right now against those first seen before the window, the list by events); logs with one count and
  a group-by of one or none, no sort or limit, through `logsByBucket`/`logGroups` (so v1 log widgets read exactly as
  before, `log_hours` included); everything else through `compute`, over a source of rows `(ts, g0, g1, s, n, e, u,
b)` per dataset: events from `event_hours` joined to the issues their search matches (`level`, `release` and
  `environment` tokens go to the hour's own columns, the rest to the issues; level is the event's own, where v1 took the
  issue's, the same whenever an issue's events share its level; a number counts the window's hours, where v1 counted
  whole UTC days), or from `events` for distinct
  `user_hash`; logs one row each, a measure from `json_extract` of the attribute in `logs.attributes` where its JSON
  type is a number (others left out), groups from the columns or `log_attributes` joins; transactions from
  `transaction_hours` (`sum_ms`, `count`, `errors`), percentiles from `transaction_buckets` through `percentile`, as
  the performance pages; sessions from `sessions_daily`, whole UTC days; monitors finished cron check-ins (not
  `in_progress`) and uptime results, one row each, failed unless `ok` (an uptime result has no environment or release,
  so a filter on either leaves it out); releases group by release, events for counts and users, sessions for
  crash-free. Aggregates are SQL over the source (count `SUM(n)`, avg `SUM(s)/SUM(n)`, rates from `e`), percentiles on
  rows nearest-rank by window functions (`ROW_NUMBER`, the smallest value with p% at or below it). Groups: every
  group's total of the first query picks the shown ones (`pickGroups`: biggest first, or the sort; level alone most
  severe first), the rest one group `null` (`CASE … IN`), exact for every aggregate as it's computed as a group. One
  count of events or logs with no group-by splits by level, as v1 did (`groupsOf`). Buckets: events and transactions
  an hour up to 7 days, else a day (a 24-hour chart ending on the hour is 24 bars; mid-hour, its first and last are
  part-hours), logs and monitors as the logs page (`intervalFor`), sessions a day. Hourly rollups read from the hour
  that holds the window's start. A number is each query's value against the span before, the same length. `Filters`
  and `applyFilters`: the dashboard's environment, release and search tokens appended to each query whose dataset
  knows the key (issues, events and logs every key). Any error is `{ kind: 'error' }`. `widgets.test.ts` on
  `test/fakes.ts`: v1 shapes read the same, aggregates refused, 24 hourly buckets with filters, avg and p95 of a log
  attribute, two group-bys, a transaction p95 against `percentile`, crash-free per release, uptime and check-ins by
  status.
- `dashboards.ts`: dashboards (`dashboards`, one row each, its widgets as JSON, who saved it last). `saveDashboard`
  writes v2; over an existing one it puts the widget list it had first in `revisions` (10 at most, `MAX_REVISIONS`,
  `{ widgets, by, at }`, the widgets as stored, v1 too) when the widgets changed, written `WHERE updated = <read>` so two
  saves at once can't drop a revision (the loser is told to open it again). `dashboardHistory`, `revisionWidgets` (read
  as stored widgets are), `addWidget` (the logs page's, at the end, through `parseWidgets`), `filterOptions` (the
  filter bar's environments and releases of the last 30 days from `event_hours`, by count, 50 each).
  `listDashboards` counts widgets only of valid JSON (else `null`). Plan: the list by `dashboards_updated`; a dashboard
  by its primary key.
- `templates.ts`: `TEMPLATES`, the prebuilt dashboards "New dashboard" offers: Crashes (`STARTER`, as before), Mobile app
  health (with crash-free users, cold and warm starts, slow and frozen frames), Web app (with LCP, INP and CLS), Backend
  and logs, Uptime and crons.
- `export.ts`: the logs page's export: `exportLogs`, the newest 10,000 (`MAX_LINES`) logs of a search, times in UTC;
  `toCsv` (a header, then a record a row: fields with a quote, comma or line break quoted and their quotes doubled;
  one starting `=` `+` `-` `@`, a tab or a return gets a `'` first so a spreadsheet runs nothing) and `toJsonLines`.
  Tested in `logs.test.ts`.
- `searches.ts`: saved searches (`saved_searches`) of a page (`PAGES`: issues, logs, explore): the viewer's own and
  everyone's shared ones, theirs pinned first, then by name, 100 at most (`saved_searches_page`); a pin is its
  owner's, one a page and email (`pinSearch` unpins the rest in the same batch); only the owner pins or deletes.
  `searches.test.ts` on `test/fakes.ts`.
- `source.ts`: stacks linked to the code. `storeCommits` (a release's commits from set-commits, its head as the
  release's `ref`, and `source_files`, every path the commits sent so far left: added or changed, not deleted since);
  `previousWithCommits` (only a project's, for a token scoped to it); `releaseCommits` (each linked to the project's `repo_url`); `frameLinks`, each in-app frame of
  an event matched to a file (`matchFile`: the file whose path ends with the most of the frame's, from its absolute
  path, its file, or for Java and Kotlin its package's folders and file; none on a tie) at the release's commit, else
  `HEAD`; `codeUrl` and `commitUrl` for GitHub and GitLab (by host); `repoUrl` checks what's typed. `storeCommits` also
  writes each commit's `patch_set` into `commit_files` (one `json_each` statement a commit, `INSERT OR REPLACE`, so
  sending a release again rewrites the same rows), and resolves what a message fixes (`fixedIssues`: "Fixes
  CRASHYARD-id" or "fixes crashyard#id", any case, a word boundary first so "Prefixes" doesn't): the issue, of a
  project the release is in, resolved in that release (`fixed_in_release`, `resolved_in_commit` the sha) with a
  `resolved` activity entry `{ release, commit: { sha, message's first line } }` by crashyard, both only while the
  issue's `resolved_in_commit` isn't already that sha, so a second set-commits adds nothing.
- `suspects.ts`: `suspectCommits(db, issue, event, repo)`: the top 5 in-app frames of the event's last exception,
  matched (`matchFile`) against the paths the issue's first release's commits changed (`release_commits` joined to
  `commit_files` by `(project_id, sha)`, deletions left out), and the commits that changed a matched path, by position,
  so newest first, each with those paths and its URL; none without a first release, in-app frames or commit files.
  `similarIssues(db, issue, event)`: issues of the project, error type only, with the same culprit (the top in-app
  frame's module and function, `culpritOf`) and a title that is the event's exception type or starts with it and `: `
  (no exception type column is kept; the title starts with it), unresolved first then by events, 10 at most; none for
  a message or a synthetic exception. Plan: `issues_project_last_seen` by project. `suspects.test.ts` on
  `test/fakes.ts`, with resolving by commit.
- `health.ts`: `usage` (Settings, Usage: per UTC day over N days from `project_days`, of every project or one: events,
  logs, transactions, `dropped` (whole envelopes a limit turned away), `filtered`, `failed`) and `health` (Settings,
  Usage and Health: the database's size, `meta.size_after` of a `SELECT 1`, against D1's 10 GB; the sizes of debug files,
  bundles and attachments; the cron's heartbeat `cron.last_run`, late past 3 minutes or when never written;
  notification failures in 7 days, the newest 20 with their channel's name; R2's `pending/` and `failed/`, one list of
  1000 each, `more` when there are more; events and logs past retention by the prune's own joins, counted up to 10,000,
  `BACKLOG_CAP`). `health.test.ts` covers both, and `autoResolve`.
- `tokens.ts`: upload tokens (`cyt_`, kept as a SHA-256, shown once), each for one project (`project_id`) or every
  project (null), listed with their project's slug; `tokenOf` marks one used; `uploadsOf`, a project's debug files and
  bundles; `debugFilesOf` (the newest 500) and `deleteDebugFile` (the row, then its file and symcache in R2 unless
  another row still names them: a fat binary's archs share one file). `source.ts`'s `storeCommits` takes `only`, a scoped token's project.
- `people.ts`: crashyard's own sign-in (`src/auth/AGENTS.md`). `ROLES` (owner, admin, member, viewer) with
  `ROLE_LABELS`, `ROLE_HINTS` and `reaches`; users (`createUser`, emails lowercased, `listUsers` with their passkey
  count, `changeRole` and `removeUser`, both refused when they'd leave no owner; removing cascades to sessions,
  passkeys, codes and tokens, their email stays on activity); sessions (`startSession`, a random 32-byte token,
  only its SHA-256 stored; `sessionUser` renews under 60 days left, at most once a day, and writes `last_seen_at` at
  most daily; `endSession`, `endSessionOf`, `endOtherSessions`; `pruneSignIn`, the cron at :20, sessions and
  challenges past their end); passkeys (`removePasskey` refused when it's the last way in: no other passkey, unused
  recovery code or GitHub; `deviceName` from the user agent, "iPhone, Safari"); challenges (`saveChallenge`,
  `takeChallenge` deletes as it reads, so one use, five minutes); invites (7 days, `useInvite` only while unused and
  unexpired); recovery codes (ten, `readableCode` groups of five without 0, O, 1, I or L, `normalCode` before
  hashing so case, spaces and dashes don't matter); user tokens (`cyp_`); `userByGitHub` and `linkGitHub`. Secrets are compared by their digests.
- `plan.ts`: the account's Workers plan with no API token: `probePlan` makes 55 `SELECT 1` in one request, and "Too
  many" past the 50th means Workers Free (Paid allows 10,000 subrequests); any other failure is no answer. `planOf`
  keeps it a day in `cloudflare.plan` (`PLAN_KEY`), `fresh` checks again; a failed check returns the last known.
  `getPlan` in `fns.ts`, asked after a page loads (`src/components/plan.tsx`). `plan.test.ts`.
- `settings.ts`: the deployment's settings (`getSetting` with a fallback when unset or not JSON, `setSetting` with who
  and when) and each viewer's preferences by email (`getPreferences` over `PREFERENCES`, `setPreference`, undefined
  clears to the default). `WORKERS_KEY`, `tail.workers`: the Workers sending runs to `tail()`, written by
  `src/api/tail.ts`. `projectDefaults`: what `createProject` starts with, the columns' defaults under what
  Settings, Projects saved.
- `notifications.ts`: channels, routes (with `frequency`, `releases`, `query`, `interval_minutes`) and metric alerts
  (`saveMetricAlert`: saving starts it again from ok, so its next read alerts if it's still past a value), and `testRoute` and `testChannel`, which send a made-up notice now through a
  route's channels or one channel and say how each went.

Keep anything a browser page imports (constants, types) free of `cloudflare:*` imports: they'd break the client build.
