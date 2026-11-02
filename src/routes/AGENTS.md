# Routes

TanStack Start's file-based routes: the dashboard's pages. `routeTree.gen.ts` is generated (by the dev
server, the build, or `tsr generate`): never edit it.

- `__root.tsx`: the document. Light or dark as the viewer chose on Settings, Appearance (the `theme` cookie
  `savePreference` sets, and `getSidebar`, the root's loader, sets from the saved preference when they differ, so a
  new browser has it from its second page), else as the system is: a script sets `.dark` before paint and when the system changes. It
  puts the theme, the `style` cookie (kept the same way), on `<html data-style>`; none is Hazard, `:root`. The
  same script keeps the browser's time zone in the `tz` cookie, so the server writes times in it. The viewport covers the notch (`viewport-fit=cover`). It links `public/manifest.webmanifest` and the home screen icon, so the dashboard installs as an app, except on a status page, which is the public's. It also has the error and not-found
  pages. Its loader is the sidebar's (projects, the one last picked, folded or not, who's signed in, their
  `preferences` and `zone`: the chosen time zone, else the `tz` cookie's, else UTC on a first visit) and its component
  is `Layout` (`src/components/shell.tsx`). The lists (`/`, dashboards and each dashboard, issues, releases,
  performance, logs) take the sidebar's project filter as `?project=`, every project's when there's none; a project's
  pages are titled by the page with the project under it. Each page gives `Shell` its breadcrumbs: the section, the
  project (a list narrowed to it, the overview's for settings), then the page (a list narrowed to a project ends at it).
- `signin.tsx`, `setup.tsx`, `invite.$token.tsx`: crashyard's own sign-in pages, the only ones open while signed out
  (`src/server.ts`), drawn without the sidebar (the root renders `Layout` only with a viewer; `getSidebar` returns
  nothing of the deployment's without one). Their loaders (`getSetupPage`, `getInvitePage`) need no role and run
  only in the server render, as every move from them is a whole page load. `/signin` (`getSignInPage`): Sign in with a passkey, Sign in with GitHub when it's set up, and Lost
  your passkey? Use a recovery code (email and code); `?next=` is where it goes after. `/setup`: the setup code, name
  and email, while there's no one (else Sign in; without `SETUP_CODE`, how to set it), with `PaidNote` on Workers Free
  (`getSetupPage` checks the plan only then). `/invite/<token>`: who invited
  them and as what, a name and email (the invite's, when it names one), Join with GitHub when it's set up, or that it
  can't be used and who to ask. `?error=` on `/signin` and an invite says what went wrong with GitHub. In the demo
  (`src/demo.ts`), `/signin` is `DemoCard` instead, from `getSignInPage`'s `demo` (its `/mcp` address).
- `status.$slug.tsx`: a public status page, open signed out (`src/server.ts`'s `STATUS_PAGE`, GET only)
  and drawn without the sidebar for anyone (the root checks the path). `getStatusPage`, no role, read in the server
  render only (a signed-out server function call is still 401): the uptime checks on the page, under their project's
  name once there are several projects' (one list without a heading otherwise), their
  state, 30 UTC days as bars (all passed, at least 99%, less, none), uptime over them and the incidents then; never a
  URL or why a check failed. Over them a summary, the worst of a check down or a major outage (red), some services
  affected (amber), maintenance going on (sky); then the open posts, an outage first, as cards with a coloured edge and
  their updates, newest first (`Markdown`), and the checks they affect; Scheduled maintenance; Past updates. A check
  an open post affects reads Major outage, Degraded or Under maintenance unless it's down. The page's branding: a
  bar of its colour on top, its logo, title and description, Go to its website (under them on a phone). A page with no check shown and no
  post is a 404, as one that doesn't exist. Loads again each minute
  with a meta refresh, no script. For a visitor without cookies it's rendered signed out and kept a minute in the
  data centre's cache (`publicStatusPage` in `src/server.ts`), so visitors and open tabs don't each read 30 days of
  results. Made and filled under Status pages, its own sidebar section. On a page's own domain
  (`src/server.ts`) it's the same page, `/` redirecting to it.
- `index.tsx`: the overview: projects with their unresolved count, events in a
  day, a 14-day sparkline and their newest release's share of the last 24 hours' sessions; then events yesterday (a whole UTC day, against the day before), unresolved, new issues in
  24 hours and monitors failing as numbers, events per day per project (stacked areas), issues new and resolved per day
  (bars side by side) and crash-free per release (`getOverviewCharts`, 30 days or `?days=14|90`, loaded with the
  overview, narrowed by `?project=`); failing monitors, new issues. Opening `/` as a page load with neither (not a
  click on All projects, which is a client navigation) redirects to the viewer's Settings, Preferences (`getHome`, in
  `beforeLoad` on the server only).
- `dashboards/index.tsx`: the dashboards (name, widgets or that they can't be read, when saved and by whom), Create
  dashboard (a template picker, `RadioGroup`: Blank, which opens in edit mode, `?edit=true`, or one of `TEMPLATES`,
  named after it unless a name is typed), and with none, Use the Crashes template (`STARTER`).
  `dashboards/$dashboardId.tsx`: one dashboard over a range (`?range=`, the logs page's), narrowed by `?project=` and
  the filter bar (`?environment=`, `?release=`, from `filterOptions`, and `?filter=`, a `SearchBar` of the issues'
  grammar; each widget takes the keys its dataset knows) (`getDashboard`, every widget's data in one call); its widgets
  in a grid of thirds (one column on a phone). Open shows a widget in `WidgetViewer`. History lists the revisions with
  Restore version (`restoreDashboard`, after a confirmation; the widgets there now become a revision). Duplicate
  dashboard saves "Copy of <name>" and opens it. Edit dashboard keeps a draft (name, widgets added, changed, duplicated, moved by drag or
  the arrows, removed; the range and filters are fixed meanwhile and the filter bar is hidden, a changed widget shows
  its preview) until Save dashboard writes the whole dashboard; Cancel drops it; Delete asks first. A chart's series or a table's
  value opens the logs or issues with the widget's query and that value.
- `issues/index.tsx`: the issues list. The search lives in the URL (`project`, `query`, `sort`, `page`, `days`); the
  search bar (`SearchBar`) and the status tabs rewrite the query. Over the list, events per day and level of the
  issues it matches for the last 14, 30 or 90 days (`?days=`, `getIssueChart`, loaded with the list), the period
  before as a dashed line. Status tabs: Unresolved, Escalating (`is:escalating`), Resolved, Ignored, All, scrolling
  on a phone; sort by priority too; each row has its priority's menu. Saved searches beside the bar (`getSavedSearches`, loaded first): with no
  `query` in the URL the viewer's pinned search opens instead of `is:unresolved`. A row's project and release are menus to show only or exclude that value. An unread row's title is bolder with a
  sky dot after it, a bookmarked one has a star, and its assignee shows beside the culprit. Bulk resolve,
  ignore, merge and delete: picked issues belong to the list they were picked in and are only those shown (another
  search, page or project starts with none); picking issues turns the list's header into "N selected" and the actions, sticky under
  the top bar, `min-h-12` so nothing moves; on a phone the actions are a bar fixed at the screen's foot instead,
  with room after the list for it.
- `issues/$issueId.tsx`: one issue (opening it marks it read for the viewer; its events under "The latest 50 events",
  or "12 matching events" after a search; `?do=resolve|ignore|assign`, a notification's link, opens `ActionPrompt`,
  and closing it drops `do` from the URL): Unmerge beside the actions when
  fingerprints were merged into it, under the title a star (bookmark), Assign to and Track issue (`issue-triage.tsx`), its
  priority (a menu), status (Escalating, ignored until it escalates or N
  users, resolved in a release), actions (on a phone, Resolve and Ignore, then More, `IssueMoreMenu`, with the
  priority, assignee, bookmark, tracker links, Unmerge and Delete; the triage row and those hidden there), counts
  and a 90-day chart, the event (`?event=` to pick one, older and
  newer), Suspect commits under the stack (sha linked through `commitUrl`, message, author, when, the files), Similar
  issues, each with Merge into this issue (a confirmation, then `mergeIssues` with this one first), tags' top values with their share (for a key the grammar can write, + and − open the project's unresolved
  issues with or without that value), events (the latest, and a `SearchBar` of scope `events` that searches this
  issue's events through `getIssueEvents`, the newest 50 that match, an answer to a search typed before the last dropped), feedback, activity and notes.
- `releases.tsx`: releases, a section per project for every project, each with its adoption stage, and on a desktop
  its adoption, sessions, users and crash-free users (crash-free sessions under its issues), in columns every row
  shares (`COLUMNS`), so values line up whatever a release's name and badge; sorted by `?sort=` (sessions, users,
  adoption, crashFree, crashFreeUsers, highest first, a release without the number last; newest when unset, sorted in
  the page); a project picker beside the sort (All projects, or one: `?project=`, the sidebar's filter too); each
  project's list 10 a page with `Pager`, back to its first page on a new sort. `projects/$slug/releases/$release.tsx`: one release, Healthy or Unhealthy by the
  project's thresholds (none without them), crash-free sessions and users, sessions and active users in 24 hours,
  adoption, its share of each day's sessions over 30 days as a line, its deploys (environment, name linked to its
  URL, when finished), its commits since the one before (from set-commits, each opening on the repository when the
  project has one), and its diff against the one before.
- `performance.tsx`: Web vitals and Mobile vitals (`VitalRows`, only those measured), then transactions by p95 with a
  sparkline of it over the period and the change since the release before (`?days=1|30`), a section per project (one
  with vitals and no transactions too); `projects/$slug/performance/transaction.tsx` (`?name=`): its own vitals, p95 per hour
  (a line, gaps joined) over the count (bars, a second axis), by release, the slowest with their
  span waterfall and Open trace.
- `analytics/`: product analytics (`src/data/analytics.ts`), its own sidebar section; `AnalyticsTabs` links Actions,
  Funnel and Retention, keeping `?project=`. `index.tsx` (`getAnalytics`, `?days=1|30`, a section per project with
  actions): active users, actions, actions per user and users who hit an error, active users per step, then actions
  by count with a sparkline, users and change (hidden on a phone), each opening `action.tsx` (`?project=&name=&by=`:
  count bars and a users line, By property, a `Select` of its keys, By release, and Issues in the same trace).
  `funnel.tsx` (`getFunnel`, `?steps=` a JSON list of up to 8 names, the three most frequent when unset; `?days=1|7`,
  30 by default): a `Select` a step, Remove step past two, Add step; Started, Finished, Conversion and Stopped after
  an error; `FunnelSteps`. `retention.tsx` (`getRetention`): Do errors drive people away?, a line each for users with
  and without an error in their first week, then `RetentionGrid`. A funnel and retention are one project's: the
  page's, else the first with actions.
- `settings/`: the settings area. `route.tsx` is its frame: `Shell` (`full`) with Settings, then Projects and the
  project on a project's page, then the page; `SettingsNav` (`src/components/settings.tsx`) at the left edge, the
  page's name as the title (the project's name under it on its pages) and the page centred beside it, up to
  `max-w-4xl`; with less room the title, the list as one select, the page. It goes by the room it has, not the
  window: the frame is `@container/settings` (the list beside from `@3xl/settings`) and the page column a
  `@container`, so settings pages lay out with container variants (`@xl:` where a page elsewhere says `sm:`, `@3xl:`
  for `lg:`); `max-sm:` stays for a phone's 40 px taps. `index.tsx` goes to General. Pages that join others are
  `-name.tsx` modules (the router skips them) exporting their component, which reads the joined page's loader with
  `getRouteApi`. `$.tsx` and `projects/$slug/$.tsx` send the old addresses of joined pages where they went (`email`
  to Notifications; a project's `keys` to Connect at Client keys, `debug-files` and `source` to Stack traces, `limits` and `filters` to
  Events, `import` to Sentry, `status-page` to Monitors), anything else a 404.
  The deployment's pages, the group "crashyard": `notifications` (below), `general` (the public URL, read-only, saying it's set in
  `wrangler.local.json`; the version and a newer release, with Update, or Automatic updates when there's none, opening `UpdateDialog` for owners; the docs), `people` (owners only, and only listed for them:
  everyone with their role as a `Select` whose menu says what each can do, last seen and passkeys, Remove after a
  confirmation, not themselves; Invite someone, an optional email and a role, the link shown once; the invites
  waiting, each with Withdraw invite; Sign in with GitHub: an optional organization and Add Sign in with GitHub,
  which posts the app's manifest to GitHub, back with `?github=added|stale|failed` as a toast; once on, the app
  linked on GitHub and Remove Sign in with GitHub), `privacy` (what's always scrubbed, and the extra field names, one
  a line or comma-separated), `tokens` (upload tokens with their
  project or All projects, who made them, when last used, Delete; Create token with a name and a project, the token
  shown once), `usage` (`getUsage` and `getHealth`: 30 UTC days of events with rate-limited, filtered and failed,
  logs and transactions, each a chart and totals, `?project=`; the Cloudflare plan, `CloudflarePlan` with `usePlan`:
  Workers Paid or Free, when checked, Check again, and what needs Paid, `PAID_FEATURES`; the database against 10 GB,
  warning from 80%; stored files) and `health` (`getHealth`, each line a `Status`: the cron, late after 3 minutes; failed notifications, each by its kind's label from `KINDS`, "Metric alert" for any
  metric kind; envelopes pending and failed; the pruning backlog). The email sender is on Notifications, in an email
  channel's form. `projects/index.tsx`, Projects: every project and its slug, each opening its General;
  New project in the header; then Defaults for new projects, their limits and retention, `defaults.project`
  (`getInstanceSettings`). A project's pages, listed under Projects in the nav only while one is open:
  `projects/$slug/route.tsx` loads its settings once (`getProjectSettings`: the project, its keys with their DSNs,
  the DSN of the first key that's on, uploads). `general` (name, slug, a changed slug warning that
  `SENTRY_PROJECT` must change and moving the page to the new slug; then `-delete`), `connect` (the
  DSN, under an amber line in the demo saying it takes no events, and `Linking`; Cloudflare Workers: the `tail_consumers` line, the Workers sending runs, `workersSeen`,
  `NeedsPaid`, each with Watch Worker, the list to watch and uncaught exceptions too; then under Client keys,
  `-keys`: per key its DSN, name, daily event limit, empty for none, events today, and an on switch that asks before
  turning a key off, then Create key), `stack-traces` (`-source` the repository and how to send commits; then
  `-debug-files`, from the page's own loader, `getProjectPage`: `NeedsPaid`, how to upload, `UploadSteps`, the newest
  500 debug files, searched in the page by name or debug ID, each with Delete after a confirmation naming it, and the
  newest 10 source map bundles), `events` (`-limits` daily event, log and transaction limits, event and log
  retention; then `-filters`, a switch per inbound filter with what it catches, text areas of error message globs,
  release globs and allowed domains, one a line, and what was filtered in 30 days, `getProjectSettings`' `filtered`,
  saved as `filters` through `updateProject`, which keeps the switches that are on and the lists' lines, 100 of 200
  characters at most), `issues`
  (Resolve issues not seen for N days, `auto_resolve_days`, off by default; Priority of new issues, a priority per
  level, `priorities`; Release health, the lowest crash-free sessions in percent, saved as a fraction, and the most
  new issues, empty for none; `-grouping`, the rules in a monospace text area with the syntax and links to Sentry's
  docs, Check rules parsing them in the page, `parseGroupingRules`, and saying the line that's wrong, Save refused
  the same way by `updateProject`) and `sentry` (Import from Sentry: `NeedsPaid` saying it goes
  slower; address, organization and project slugs, a token kept only in the form; asks `importFromSentry` page after
  page with a count, Continue import from the page it stopped at; then Forward to Sentry, the DSN saved as
  `forward_dsn` by `updateProject`, empty for none). The viewer's own, the group "You": `account`
  (`getSignIn`: passkeys with Rename and Remove, Add passkey; recovery codes left and Make new
  codes, shown once; where they're signed in, This browser, Sign out each and Sign out everywhere else; in the demo,
  whose viewer has none, it isn't listed and redirects to Appearance),
  `agent-tokens` (`getAgentTokens`; in the demo, which takes no token, In the demo with the `claude mcp add` line for
  its open `/mcp` over the list, empty there: a person's `cyp_` tokens for MCP with a name, Read only or Read and change,
  and an expiry, the token and the `claude mcp add` command shown once, Delete), `appearance` (the theme, `STYLES` in
  `src/data/settings.ts`, as tiles of crashyard in small, `MiniWindow`, each wearing its own `data-style` to preview
  it, and System, Light, Dark, both applied at once) and `preferences`; both save each change at once through
  `savePreference` and read from the root's loader. Preferences: `-date-and-time`, a time zone from `Intl.supportedValuesOf`, empty for the browser's, and a
  12 or 24-hour clock; `-stack-traces`, newest or oldest frame first, other frames open or not; `-home`, the
  overview's project and range; Push notifications, `src/components/push.tsx`'s `Push` with `getPush` in the page's loader (Notifications has it too, on top). Each page saves only its own fields through `updateProject`, whose checks are per
  field. `projects/$slug/settings.tsx` redirects to the project's General.
- `explore.tsx`: Explore, events across issues. The search lives in the URL (`project`, `query`, `range`, `columns`,
  comma-separated, `groupBy`, `users`, `before`): `SearchBar` scope `events`, saved searches of page `explore` (the
  pinned one opens with no `query`), a time range; Columns (a text field of tag names, applied on Enter or blur),
  Group by (nothing, the built-ins or a chosen column), Count events or users; the count over time (stacked by group,
  with a legend), the groups with their counts (a click searches that value), then the events (received, issue
  title, the columns, narrower than md the received time and each column as a label and value pair under the title, and
  Open issue on its event) with Show older events (`before`).
  `getExplore`, one call.
- `traces/$traceId.tsx`: `/traces/<id>`, what's kept of a trace (`getTrace`): its stored transactions with their span
  waterfall, its events with their issues, its logs, and a line saying only the slowest transactions keep their spans.
  Every trace link opens it: a log's, an event's on its issue, a slow transaction's.
- `logs.tsx`: the logs explorer. The search lives in the URL (`project`, `query`, `range`, `from`, `to`, `groupBy`): the
  search bar (`SearchBar`), a time range, and over the list logs per bucket and level (`getLogChart`, loaded with the
  list; the period before as a dashed line). A drag across the chart sets `from` and `to` (ms, clamped to the chart's
  span), which stand in for the range while they're set (it reads "Custom" with the span; Reset clears them, back to the
  range; a bad pair is dropped and the range counts). Facets (folded on a phone) are bars of their share with + and −
  (`addValue`: a second value of a key makes `key:[a,b]`; none for a key the grammar can't write, `isSearchableKey`);
  click a line for every field and attribute, each a menu to show only, exclude or copy it (`logAttributeKey`: none for
  the SDK's `sentry.*`, but `sentry.release` and `sentry.environment` search their columns), and Open trace, its trace's
  page. Live (asks every 2 s for what arrived after the newest id shown, the next request only once the last is back, at
  once while a burst is read; a log already shown never twice; off with an exact span), Older (disabled while it loads). Group by, None by default, then Then by, shown once the first is set (`?groupBy=`: level, release,
  environment, project, or an attribute, the stored keys asked for when the menu first opens; `getLogGroups` loaded
  instead of `getLogChart`): the chart's series are the 8 biggest groups and the rest, and over the list a table of them
  with their logs, the change since the span before ("new" when there were none), their share, + and − (a click on the
  value shows only it; none and the rest can't be picked). The chart doesn't poll: it's loaded again on each search.
  Times to the millisecond in the viewer's zone and clock. Charts: `?fn=` up to 3 functions, comma-separated (count
  when unset), Add chart (a function and a numeric attribute); a count by one field or none is the page's own chart
  above, the rest charts through `getLogMaths` (a logs widget each, `WidgetView`). `?groupBy=` takes 2 fields,
  comma-separated (By, Then); with two, or with more functions than a count, the table is a row per group and a column
  per function (`getLogMaths`' table) instead of the groups table. Each chart's menu: Add to dashboard (a dashboard
  and a title, `addWidget`), Create metric alert for a count (`/settings/notifications?metric=log_count&query=…&project=…`), Remove
  chart. Export: CSV or JSON Lines of the current search, through `logs_.export.ts`. Saved searches beside the bar: with no `query` in the
  URL the viewer's pinned one opens, so a search cleared while one is pinned stays in the URL as `query=`.
- `monitors/`: the monitors (status, schedule or URL, the last 30 results as bars; `getMonitors` and `getMonitor`
  send an uptime check's header values and body only to admins, `monitorForPage`, as they may hold credentials), adding an uptime check or a cron
  monitor, and one monitor: muted since when, if it is; up, or runs ok, over 24 hours, 7 and 30 days; a p95 line of
  response times or run times; its environments with their status; its results or check-ins, how to check in;
  Errors during this job, each opening its event; incidents; pause, edit, delete; an uptime check says which status
  pages show it, each a link, or Not on any status page (`pagesShowing`). `status-pages.$.tsx` sends the old
  `/monitors/status-pages` addresses to `/status-pages`.
- `status-pages/`, its own sidebar section, under Monitors: `index.tsx` (`getStatusPages`: Create status page, a name, `createStatusPage`, admin, opening the new
  page; each page, its domain or `/status/<slug>`, the checks shown and posts not ended, or Not public yet; No status
  pages yet) and `$slug.tsx` (`getStatusPosts`, null as a 404: Open status page; every project's uptime
  checks under its name, two columns with room, each a switch for the page, `setStatusPageCheck`, admin; Post to the status page, a kind, its
  state, a title, for maintenance its start and end as `datetime-local` in the viewer's zone, Affects (a checkbox
  per check on the page, not for a notice; 40 px on a phone), and a message, `createStatusPost`, member; then Now on
  the page and Ended in the last 30 days, each post with its updates and who posted them, what it affects, Add
  update, `addStatusUpdate`, its Affects filled in, and Delete after a confirmation, `deleteStatusPost`, admin; Look
  and address, `updateStatusPage`, admin: name, address (the slug, opening the page at the new one), page title, brand
  color, a picker and its hex, description, logo and website, https only, and the custom domain with how to add it to
  the Worker in Cloudflare; Delete status page after a confirmation, `deleteStatusPage`, admin).
- `notifications.tsx`: what crashyard sent in the last 30 days, newest first (`getSentNotifications`, the newest 100):
  each notice's icon by kind, title linking to its page, `noticeLine`, when, and a badge a channel (held for quiet
  hours, or red and not sent with the error under it); Notification settings in the header; Nothing sent yet with Set
  up notifications.
- `settings/notifications.tsx`, the group "crashyard" (`getPush` too. Each channel row says what it gets, from the routes naming it: how many kinds of alert from which projects, or an amber Gets no alerts yet with Add it to every route, `addChannelToRoutes`, for admins; the viewer's own push channel lists their devices, Turn on for this device when this one is off, and its dialog has `PushControls`; with no push channel yet, Push to your devices, dashed, below the list. A route folds more than three kinds into "N kinds of alert" with Show the kinds, and one whose channels are all gone says Sends nowhere, with Choose a channel. `getNotifications` keeps channel secrets on the server: Telegram's webhook secret for everyone,
  bot tokens and webhook addresses for anyone below admin): channels (Telegram, its chat found from the bot's latest messages; Slack and Discord, webhooks
  in their formats, each with where its URL comes from and checked against its host; email, with the address it's sent from, or what to set up first
  while the deployment has no `EMAIL_FROM`; a JSON webhook; a person's push channel, made by their first device, only renamed, given quiet hours or deleted here (`saveChannel` takes `push` only for an existing one, keeping its config), Add a channel saying each person turns push on for their own device, on this page or in Preferences; quiet hours, entered and kept in the channel's
  `quiet_zone`, else the viewer's zone from `useTimePrefs`, and saved in it; one from before 0020, in UTC, shows in
  the viewer's zone at today's offset; the row names the zone when it isn't the viewer's), routes, each with a
  test send (with Frequency reached, "Only when an issue gets" N events or users in a window, its hint saying it
  alerts again only after that long and, for users, that they count from the events kept; releases as globs; tags
  through `SearchBar`, checked on save by `tagFilterError`; "Wait before alerting again"; the row sums them up), and
  metric alerts: each with its state, its value and when it changed; Create metric alert opens a form, its footer with Save
  sticky at the dialog's foot while the fields scroll, with name,
  project, metric, filter, window of 1, 6 or 24 hours (it says it counts whole hours, so up to an hour more), direction and the warning and critical values, in percent or
  milliseconds by the metric, each metric starting from its own defaults. `?metric=` (with `query` and `project`, a slug)
  opens Create metric alert filled in, the logs page's Create metric alert; closing it clears them from the URL.
- `logs_.export.ts`: `/logs/export`, a server route (no page, not nested in `logs.tsx`): the search of `query`,
  `project`, `range` or `from` and `to`, as `format` csv or jsonl, the newest 10,000, as an attachment with `nosniff`
  and a sandbox CSP, for a signed-in viewer (403 without `x-crashyard-viewer`).
- `attachments.$id.ts`: a server route, no page: an attachment from R2 for a signed-in viewer (the
  `x-crashyard-viewer` header `src/server.ts` sets, else 403). Images by `attachmentType` (png, jpeg, gif, webp, by
  type or else name) inline as that type; everything else, SVG and HTML included, `application/octet-stream` as
  `attachment`. Every answer has `nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`; the e2e test
  checks them.
- `src/router.tsx` sets `defaultRemountDeps` to the params: a page opened with other params (the sidebar's project
  switch on a project's settings page, another issue, dashboard or monitor) is mounted anew, so it never shows or
  saves what was typed on the one before.
- Times on a page are relative to the `now` its loader returns, so the server and the browser render the same text;
  dates and times go through `<Time>` or `formatTime` (`src/components/time.tsx`), in the viewer's zone and clock,
  the same on both sides.
- Pages are behind sign-in (`src/server.ts`, `src/auth/AGENTS.md`); `/api/*` and `/auth/*` never reach Start.
- Data for a page comes from a server function (`src/fns.ts`) called in the loader; after a change,
  `router.invalidate()`.
