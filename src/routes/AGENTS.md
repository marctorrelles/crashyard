# Routes

TanStack Start's file-based routes: the dashboard's pages. `routeTree.gen.ts` is generated (by the dev
server, the build, or `tsr generate`): never edit it.

- `__root.tsx`: the document. Light or dark as the viewer chose on Settings, Appearance (the `theme` cookie
  `savePreference` sets), else as the system is: a script sets `.dark` before paint and when the system changes. The
  same script keeps the browser's time zone in the `tz` cookie, so the server writes times in it. The viewport covers the notch (`viewport-fit=cover`). It also has the error and not-found
  pages. Its loader is the sidebar's (projects, the one last picked, folded or not, who's signed in, their
  `preferences` and `zone`: the chosen time zone, else the `tz` cookie's, else UTC on a first visit) and its component
  is `Layout` (`src/components/shell.tsx`). The lists (`/`, dashboards and each dashboard, issues, releases,
  performance, logs) take the sidebar's project filter as `?project=`, every project's when there's none; a project's
  pages are titled by the page with the project under it. Each page gives `Shell` its breadcrumbs: the section, the
  project (a list narrowed to it, the overview's for settings), then the page (a list narrowed to a project ends at it).
- `index.tsx`: the overview: a banner when a newer crashyard is out, projects with their unresolved count, events in a
  day and a 14-day sparkline; then events yesterday (a whole UTC day, against the day before), unresolved, new issues in
  24 hours and monitors failing as numbers, events per day per project (stacked areas), issues new and resolved per day
  (bars side by side) and crash-free per release (`getOverviewCharts`, 30 days or `?days=14|90`, loaded with the
  overview, narrowed by `?project=`); failing monitors, new issues. Opening `/` as a page load with neither (not a
  click on All projects, which is a client navigation) redirects to the viewer's Settings, Home (`getHome`, in
  `beforeLoad` on the server only).
- `dashboards/index.tsx`: the dashboards (name, widgets or that they can't be read, when saved and by whom), New
  dashboard (a template picker, `RadioGroup`: Blank, which opens in edit mode, `?edit=true`, or one of `TEMPLATES`,
  named after it unless a name is typed), and with none, Use the Crashes template (`STARTER`).
  `dashboards/$dashboardId.tsx`: one dashboard over a range (`?range=`, the logs page's), narrowed by `?project=` and
  the filter bar (`?environment=`, `?release=`, from `filterOptions`, and `?filter=`, a `SearchBar` of the issues'
  grammar; each widget takes the keys its dataset knows) (`getDashboard`, every widget's data in one call); its widgets
  in a grid of thirds (one column on a phone). Open shows a widget in `WidgetViewer`. History lists the revisions with
  Restore (`restoreDashboard`, after a confirmation; the widgets there now become a revision). Duplicate dashboard
  saves "Copy of <name>" and opens it. Edit keeps a draft (name, widgets added, changed, duplicated, moved by drag or
  the arrows, removed; the range and filters are fixed meanwhile and the filter bar is hidden, a changed widget shows
  its preview) until Save writes the whole dashboard; Cancel drops it; Delete asks first. A chart's series or a table's
  value opens the logs or issues with the widget's query and that value.
- `issues/index.tsx`: the issues list. The search lives in the URL (`project`, `query`, `sort`, `page`, `days`); the
  search bar (`SearchBar`) and the status tabs rewrite the query. Over the list, events per day and level of the
  issues it matches for the last 14, 30 or 90 days (`?days=`, `getIssueChart`, loaded with the list), the period
  before as a dashed line. Status tabs: Unresolved, Escalating (`is:escalating`), Resolved, Ignored, All, scrolling
  on a phone; sort by priority too; each row has its priority's menu. Saved searches beside the bar (`getSavedSearches`, loaded first): with no
  `query` in the URL the viewer's pinned search opens instead of `is:unresolved`. A row's project and release are menus to show only or exclude that value. Bulk resolve,
  ignore, merge and delete.
- `issues/$issueId.tsx`: one issue: its priority (a menu), status (Escalating, ignored until it escalates or N
  users), actions, counts and a 90-day chart, the event (`?event=` to pick one, older and
  newer), tags' top values with their share (for a key the grammar can write, + and − open the project's unresolved
  issues with or without that value), events, feedback, activity and notes.
- `releases.tsx`: releases (crash-free sessions when the SDK sends them), a section per project for every project;
  `projects/$slug/releases/$release.tsx`: one release's commits since the one before (from set-commits, each opening on
  the repository when the project has one), and its diff against the one before.
- `performance.tsx`: transactions by p95 with a sparkline of it over the period and the change since the release
  before (`?days=1|30`), a section per project; `projects/$slug/performance/transaction.tsx` (`?name=`): p95 per hour
  (a line, gaps joined) over the count (bars, a second axis), by release, the slowest with their
  span waterfall and trace links.
- `settings/`: the settings area. `route.tsx` is its frame: `Shell` with Settings, the project when it's a project's
  page, then the page; the page's name as the title; `SettingsNav` (`src/components/settings.tsx`) beside the page
  (a select over it on a phone). `index.tsx` goes to General. The deployment's pages, the group "crashyard": `general`
  (public URL and Access, read-only, each saying it's set in `wrangler.local.json`), `email` (the sender, read-only,
  and Send test email to a typed address), `defaults` (new-project limits and retention, `defaults.project`),
  `privacy` (what's always scrubbed, and the extra field names, one a line or comma-separated), `tokens` (upload
  tokens with their project or All projects, who made them, when last used, Delete; Create token with a name and a
  project, the token shown once; Agents: the MCP URL and Let agents change issues, `agents.can_change`), `usage` (30
  UTC days of events with rate-limited, filtered and failed, logs and transactions, each a chart and totals,
  `?project=`), `health` (the database against 10 GB, warning from 80%; stored files; the cron, late after 3 minutes; failed
  notifications; envelopes pending and failed; the pruning backlog) and `about` (the version, a newer release,
  the docs). Each loads its own server function (`getInstanceSettings`, `getTokens`, `getUsage`, `getHealth`).
  `projects/$slug/route.tsx` loads the project's settings once (`getProjectSettings`: the project, its keys with their
  DSNs, the DSN of the first key that's on, uploads) for its pages, the group named by the project: `general` (name,
  platform, slug; a changed slug warns that `SENTRY_PROJECT` must change, and the page moves to the new slug),
  `issues` (Resolve issues not seen for N days, `auto_resolve_days`, off by default; Priority of new issues, a
  priority per level, `priorities`), `grouping` (the rules in a monospace text area with the syntax and links to
  Sentry's docs; Check rules parses them in the page, `parseGroupingRules`, and says the line that's wrong; Save is
  refused the same way by `updateProject`), `keys` (Create key; per key its
  DSN, name, daily event limit, empty for none, events today, and an on switch that asks before turning a key off),
  `limits` (daily event, log and transaction limits, event and log retention), `source` (the repository and how to
  send commits), `connect` (the DSN and `Linking`), `debug-files` (how to upload, `UploadSteps`; the newest 500 debug
  files, searched in the page by name or debug ID, each with Delete after a confirmation naming it, `getProjectPage`;
  the newest 10 source map bundles) and `delete`. The viewer's own, the group "You", each saved at once through
  `savePreference` and read from the root's loader: `appearance` (System, Light, Dark, applied at once), `date-and-time`
  (a time zone from `Intl.supportedValuesOf`, empty for the browser's, and a 12 or 24-hour clock), `stack-traces`
  (newest or oldest frame first, other frames open or not) and `home` (the overview's project and range). Each page saves only its own fields through `updateProject`, whose
  checks are per field. `projects/$slug/settings.tsx` redirects to the project's General.
- `logs.tsx`: the logs explorer. The search lives in the URL (`project`, `query`, `range`, `from`, `to`, `groupBy`): the
  search bar (`SearchBar`), a time range, and over the list logs per bucket and level (`getLogChart`, loaded with the
  list; the period before as a dashed line). A drag across the chart sets `from` and `to` (ms, clamped to the chart's
  span), which stand in for the range while they're set (it reads "Custom" with the span; Reset clears them, back to the
  range; a bad pair is dropped and the range counts). Facets (folded on a phone) are bars of their share with + and −
  (`addValue`: a second value of a key makes `key:[a,b]`; none for a key the grammar can't write, `isSearchableKey`);
  click a line for every field and attribute, each a menu to show only, exclude or copy it (`logAttributeKey`: none for
  the SDK's `sentry.*`, but `sentry.release` and `sentry.environment` search their columns), and its trace's logs and
  issues. Live (polls every 2 s for newer; off with an exact span), Older. Group by (`?groupBy=`: level, release,
  environment, project, or an attribute, the stored keys asked for when the menu first opens; `getLogGroups` loaded
  instead of `getLogChart`): the chart's series are the 8 biggest groups and the rest, and over the list a table of them
  with their logs, the change since the span before ("new" when there were none), their share, + and − (a click on the
  value shows only it; none and the rest can't be picked). The chart doesn't poll: it's loaded again on each search.
  Times to the millisecond in the viewer's zone and clock. Charts: `?fn=` up to 3 functions, comma-separated (count
  when unset), Add chart (a function and a numeric attribute); a count by one field or none is the page's own chart
  above, the rest charts through `getLogMaths` (a logs widget each, `WidgetView`). `?groupBy=` takes 2 fields,
  comma-separated (By, Then); with two, or with more functions than a count, the table is a row per group and a column
  per function (`getLogMaths`' table) instead of the groups table. Each chart's menu: Add to dashboard (a dashboard
  and a title, `addWidget`), Create alert for a count (`/notifications?metric=log_count&query=…&project=…`), Remove
  chart. Export: CSV or JSON Lines of the current search, through `logs_.export.ts`. Saved searches beside the bar: with no `query` in the
  URL the viewer's pinned one opens, so a search cleared while one is pinned stays in the URL as `query=`.
- `monitors/`: the monitors (status, schedule or URL, the last 30 results as bars), adding an uptime check or a cron
  monitor, and one monitor: its results or check-ins, how to check in, incidents, pause, edit, delete.
- `notifications.tsx`: channels (Telegram, its chat found from the bot's latest messages; Slack and Discord, webhooks
  in their formats, each with where its URL comes from and checked against its host; email, or what to set up first
  while the deployment has no `EMAIL_FROM`; a JSON webhook; quiet hours in the browser's time), routes, each with a
  test send (with Frequency reached, "Only when an issue gets" N events or users in a window; releases as globs; tags
  through `SearchBar`, checked on save by `tagFilterError`; "Wait before alerting again"; the row sums them up), and
  metric alerts: each with its state, its value and when it changed; Create metric alert opens a form with name,
  project, metric, filter, window of 1, 6 or 24 hours, direction and the warning and critical values, in percent or
  milliseconds by the metric, each metric starting from its own defaults. `?metric=` (with `query` and `project`, a slug)
  opens Create metric alert filled in, the logs page's Create alert; closing it clears them from the URL.
- `logs_.export.ts`: `/logs/export`, a server route (no page, not nested in `logs.tsx`): the search of `query`,
  `project`, `range` or `from` and `to`, as `format` csv or jsonl, the newest 10,000, as an attachment with `nosniff`
  and a sandbox CSP, for a signed-in viewer (403 without `x-crashyard-viewer`).
- `attachments.$id.ts`: a server route, no page: an attachment from R2 for a signed-in viewer (the
  `x-crashyard-viewer` header `src/server.ts` sets, else 403). Images by `attachmentType` (png, jpeg, gif, webp, by
  type or else name) inline as that type; everything else, SVG and HTML included, `application/octet-stream` as
  `attachment`. Every answer has `nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`; the e2e test
  checks them.
- Times on a page are relative to the `now` its loader returns, so the server and the browser render the same text;
  dates and times go through `<Time>` or `formatTime` (`src/components/time.tsx`), in the viewer's zone and clock,
  the same on both sides. Quiet hours on Notifications are still entered and shown in the browser's own zone.
- Pages are behind Access (`src/server.ts`); `/api/*` never reaches Start (see `src/api/`).
- Data for a page comes from a server function (`src/fns.ts`) called in the loader; after a change,
  `router.invalidate()`.
