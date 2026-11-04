# Components

- `ui/`: shadcn/ui (`radio-group` for the template picker among them; style `radix-nova`, neutral, `components.json` at the root). Added with
  `yes n | pnpm dlx shadcn@latest add <name>` (the `n` keeps the files it would overwrite); kept as upstream writes
  them, so they can be re-added with `--overwrite`. After adding one, fix its `cn` import to `@/lib/utils` if the CLI
  wrote `"cn"` (and `pnpm remove cn` if it added that package). One change from upstream: `dropdown-menu`'s content and sub content
  are `w-max` up to the room on screen (`max-w-(--radix-dropdown-menu-content-available-width)`), not the trigger's
  width, so a menu off a small trigger keeps each item on one line, and keep 8 px from the screen's edges
  (`collisionPadding`); and `sidebar`'s `SidebarInset` is a `div`, not a `main`, as the shell's page holds the one
  `main`; and `select`'s trigger is `min-w-0`, so a long value is cut short rather than widening the form past the
  screen; and `chart`'s tooltip rows keep a gap between a series' name and its value and truncate a long name. Keep
  them all after a re-add. The themes are in `src/styles.css`: Hazard on `:root`, the others on `[data-style]`, each setting every variable
  (font, radius, `--spacing`, colours, light and dark) so one can nest in another. A colour in a component is a
  theme variable, never a fixed shade, except the level and palette colours of `charts.tsx`; in the sidebar, the
  `sidebar-*` ones, which Hazard makes dark in light mode too.
- Icons are Tabler's (`@tabler/icons-react`, `IconName`; `components.json`'s `iconLibrary` is `tabler`, so re-added
  shadcn components come with them too), brands included (`IconBrandSlack`, …). No other icon set.
- Our own components sit beside `ui/`, built from those. Every one works on a phone (touch targets of 40 px or more,
  nothing wider than the screen) and in light and dark. Nothing wider than the screen, with names of any length:
  - A grid holding names or rows names its columns: `grid-cols-1` on a phone, not the implicit `auto` column, which
    grows to the longest truncated line.
  - Names, URLs and emails in text that wraps, such as headings, labels and fact lines, take `wrap-anywhere`.
    `break-words` doesn't shrink a flex or grid item.
  - A breadcrumb above the page truncates at half the bar.
- `shell.tsx`: `Layout` (the root's: shadcn's `Sidebar`, kept between pages: the project filter on top, then the same
  pages whatever's picked, Overview, Dashboards, Issues, Explore, Releases, Performance, Analytics, Logs, Monitors, Notifications
  (what was sent; its settings are in Settings), and at
  the foot, for owners while a newer crashyard is out, Update available (tinted, unlike the pages' grey hover; it opens `UpdateDialog`), Settings, then who's signed in, their name else email, with Sign out: a form POST to `/auth/signout`; in the demo Leave demo,
  Demo visitor, and `DemoBanner` over every page, a slim bar with Deploy your own (`DEPLOY_YOUR_OWN`, the README's Get
  started) until closed for the browser's session, sessionStorage through `useSyncExternalStore`, open in the server render), `Shell` (a page: the top bar with the
  sidebar's toggle and the page's `crumbs`, section down to the page, a phone showing the last two; then its width,
  `wide` for lists, `full` for settings: from the sidebar's edge, not centred), `PageHeader`, `Empty` (shadcn's Empty: an icon, a title, one line and an optional action; `compact` inside a
  section), `useProjects`, `usePreferences` (the viewer's, from the root's loader). `Logo`: the mark, one path (its tiled drawings are `docs/images/logo.svg`, the README's, and `src/favicon.svg`). `Loader`, the sidebar's logo once a page has been loading 300 ms: Tumblers, `PIECES` (the mark in five pieces: its three rings cut on the mouth's lines, then the two folds over them, each reaching 0.3 into the rings beside it so no seam shows; together the mark to 0.01), each turning its own way and speed, outside in each the other way from the one before, through the Web Animations API (`spin`, from where it is, up to speed within 40°), turn after turn for as long as the page loads; then `land`, each on at its speed until 90° before its place and braking evenly into it, and `onDone` swaps back to the logo. Loading again while they land turns them on from where they are. Still with reduced motion. The only loader of its kind: elsewhere a Loading… line has Tabler's `IconLoader2` spinning, and charts keep their skeletons. The lists (overview, dashboards, issues, Explore, releases, performance, every analytics tab, logs)
  take the filter as `?project=` (on a dashboard, picking a project keeps it and its range); the project shown comes
  from that, `/projects/$slug` or an issue's own; pages of no project keep the one last picked (cookie
  `crashyard_project`, read back by the root's loader, like shadcn's `sidebar_state`). The filter's menu also has the
  picked project's settings (`/settings/projects/<slug>/general`); picking a project on one of its settings pages
  keeps the page for the new project, and All projects goes to Settings, Projects. An action's page is its
  `?project=`'s; picking another goes to Analytics.
- `analytics.tsx`: the analytics pages' `AnalyticsTabs` (links with `aria-current`, scrolling sideways on a phone,
  only sideways: the y axis clipped, the baseline an inset shadow under the underline), `openAnalyticsProject` (a
  one-project tab's `beforeLoad`, see `src/routes/AGENTS.md`),
  `FilterBar` (a `Select` each for platform, OS, country and release, of what the last 30 days had, then a property
  and one of its values, and Clear filters; `readFilter` and `toFilter` turn the URL's filter into the server
  functions'), `PeriodSelect` and `readDays`, `Stats` (tiles of a number, its change and a hint), `Change` (green
  the way that's good), `Breakdown` (a card of `BarList` bars, + filtering by a value), `share`, `gap`,
  `countryName` (`Intl.DisplayNames`), `valueLabel`, `FunnelSteps` (a card a step: its bar in `--chart-1`, users,
  the share of the step before and the median time; who stopped there, how many hit an error first, amber, and
  their issues as `IssueRows`), `RetentionGrid` (a row a weekly cohort, a cell shaded by `--chart-1`, scrolling
  inside its border), `ActionSelect` and `BreakdownSelect`.
- `add-to-dashboard.tsx`: `AddToDashboard`, a chart as a widget at the end of a picked dashboard (`addWidget`), from
  the logs page and Insights.
- `bits.tsx`: `Sparkline` (SVG bars, no chart library; `label` for what they are when not events per day), `Ago`
  (relative to a `now` from the loader, the whole date in its title), `Level`, `count`, `percent`, `Pager` ("Page 2 of 5" and two arrows under a list paged in the browser, nothing when it fits on one; the releases' lists and the widget viewer's table).
- `time.tsx`: `formatTime(at, { zone, clock }, style)` (`Intl.DateTimeFormat` in English, `hourCycle` from the clock,
  formats cached; an unknown zone writes UTC), `useTimePrefs` and `<Time>`. Every date or time the app shows goes
  through them, so the server and the browser write the same text.
- `performance.tsx`: `ms` (a duration), `vitalValue`, `VitalRows` (a "Web vitals" and a "Mobile vitals" row of
  cards, each vital's p75, its rating as a dot and words, Not rated for those Sentry doesn't rate, and "Up 12% on the
  release before", or "Same as the release before" under 1%; a row only with a vital in it), `Period` and `Waterfall` (spans as
  bars, indented by depth; on a phone the bar goes under its name; each duration after its bar when it ends by 80%,
  else before it when it starts from 20%, else inside its end in white, never wrapped).
- `search-bar.tsx`: `SearchBar` (scope issues, logs or events, Explore's, with `EVENT_KEYS` and the issues' tags): every `key:value` of the query is a pill (key, operator
  menu, value, × with a hairline between, the key and operator grey, the value bold; on a phone each reaches to a 44 px
  tap; `is:` has no key; the key or value turns it back into text with the value selected), free words stay in the
  input. A popover (`Popover` anchored on the bar, its width; `Command`, unfiltered, highlighted from the input)
  proposes what `src/search/suggest.ts` says for the caret. ↑ ↓ move, Enter picks what's highlighted or else searches
  (nothing is highlighted until an arrow is pressed, so a plain search never loses its Enter), Tab picks the first or
  highlighted, Esc closes, Backspace on an empty input turns the last pill back into text; while an IME composes, its
  keys are left to it. Picking a value makes a pill and searches; changing or removing a pill searches. Keys come once
  on focus and values 150 ms after typing stops (each kind with its own timer, so one never cancels the other), from
  `getSuggestions`, cached by scope, project, range, key and prefix for the page's life (a late reply only fills its own
  entry; while one is on its way, a shorter prefix's narrows). `onChange` reports the whole query as it stands (pills
  and typed text) on every change. On the issues and logs pages, and in the widget dialog. `SavedSearches`, beside the bar on Issues and
  Logs: a popover of the saved searches (pinned first, a pin and a people icon for shared ones, the owner of someone
  else's), a pick searches it; on the viewer's own, Pin (so the page opens with it), Unpin and Delete after a
  confirmation; Save search names the current query and can share it with everyone.
- `charts.tsx`: shadcn's `ChartContainer` over recharts. `TimeChart`: counts per bucket (`x` is bucket starts in ms or
  UTC days `YYYY-MM-DD`), series stacked as bars or areas (lines aren't; `stacked={false}` puts bars side by side), a
  series' own `kind` and `axis: 'right'` (a second axis, `formatRight`; the transaction page's count under its p95),
  null values skipped in a line (joined across), `legend`, `onSeries` (a click on a series' bar, area or line, with a
  fine pointer only, `useFinePointer` in `src/hooks/`: on touch a tap shows the tooltip, and the table or legend drill
  in), `previous` (the period before) as a dashed line in the text's colour, faded, a tooltip per bucket (at most 18 rem wide, a long name truncated), and with
  `onZoom` a drag across it gives the buckets' exact span (the logs page zooms with it). Days are written as the UTC day
  they are; hours in the viewer's zone and clock (`useTimePrefs`), and over two days or more of hours a tick a day with its date (over less, a
  tick that starts a day says its date); it draws inside `<ClientOnly>`, a `Skeleton` of its size before. Colours: a
  series' own, else `LEVEL_COLORS` by key, the same as `Level`'s dots (fatal red 600, error orange 500, warning and
  logs' warn amber 400, info sky 500, debug zinc 400, logs' trace fainter), else the theme's `--chart-n`; `PALETTE`, 8
  colours for groups and projects; the legend is ours, under the chart, so however many lines it wraps to, the
  chart keeps its height. `BarList`: values with a bar for their share, count and percent
  (or `format`'s text), a long value truncated inside the list's width; with a pointer that hovers, Show only and
  Exclude float in a small toolbar just above the row's end, taking no room, on hover or once tabbed to; on touch a + and
  a − follow the row, always shown, 40 px.
  `BigNumber`: a number, its label and its change (more reads red, less green, the other way with `higherIsBetter`,
  none as rounded muted), `tone` amber or red past a widget's thresholds, on the overview and dashboards.
- `widget.tsx`: a dashboard's widget. `WidgetCard` (title, dataset and group-by unless the title says just that,
  queries, each aggregate in words, `aggregateName`: "Unique users", "p95 of duration"; Open in view mode; draggable in edit mode, native HTML drag and drop onto another card), `WidgetView` (numbers
  with their change, in their unit, `formatValue`, the first one amber or red past its thresholds; unique users as a
  dash reading Not reported when the window's events name no user; a chart, a query in
  another unit on a second axis, averages and percentiles as unstacked lines; a table with a column per group field
  and per query, Change and share for one query; issues; markdown; what went wrong; a series or the first field's value
  opens the logs or issues with it added, for logs and events), `WidgetActions` (edit mode: a grip, edit, duplicate, up, down, remove; 40 px on a phone), `WidgetViewer` (a widget
  full width in a dialog, then its numbers as a table sortable by any column and paged by 20, scrolling sideways
  inside its border on a phone (`min-w-0` on the dialog's grid items): a bucket a row for a
  chart, a group for a table, an issue for a list; a table or list isn't drawn twice; Open in Issues, Logs,
  Performance, Monitors or Releases by dataset, `listOf`), `WidgetDialog` (the builder: title, dataset, then each query's
  search (`SearchBar` for issues, events and logs, a text field of the fixed keys otherwise), function and field or
  attribute, label when there are several, Add query up to 3; markdown a text area; display; group by and then by; sort
  and groups shown only once a group-by is set, issues shown for a list; every input labelled, or with an
  `aria-label` where a label would crowd, the search bar's through `SearchBar`'s `label`; thresholds for a number; width; a preview from `previewWidget` with the dashboard's
  filters 400 ms after a change, a reply for an older widget never shown) and `GroupBy` (a dataset's fields, logs'
  attributes asked for once; `attributesOnly` for the logs page's Add chart).
- `value-menu.tsx`: `ValueMenu`, a value on a page as a `DropdownMenu`: show only this, exclude this, copy. Pages pass
  `addValue` for the first two, only for a key the grammar can write (`isSearchableKey`); its trigger sits above a row's
  link (`z-10`), its tap area 40 px high on a phone.
- `issue-actions.tsx`: resolve, ignore, reopen, merge, delete, for one issue or a selection. Ignore is a split
  button: its click ignores until it escalates; the menu has that first, then forever, N more times, N more users and
  for a time. Resolve's menu: now, in next release, in current release (naming one issue's latest; hidden when it
  has none), and on one issue Resolve in a release…, a dialog with a `Select` of `releases`. Delete is a menu: Delete, and Delete and discard future events (`discard`), each confirmed
  by `useIssueChange` ("Delete 3 issues and discard their future events? This can't be undone."), which the phone's
  More menu calls too; `deleteOnPhone={false}` hides the menu on a phone, where More has it.
- `issue-actions.tsx`'s `UnmergeButton` opens `UnmergeDialog` (controlled, so More opens it too), which loads the
  merged fingerprints each time it opens (`getMergedFingerprints`), a `RadioGroup` of them, each with what tells it
  apart: its newest message, its top in-app frame, its events, first and last seen; and Unmerge, which opens the new
  issue.
- `issue-triage.tsx`: an issue's header triage. `BookmarkButton` (a star, filled amber when on), `AssignMenu`
  (Assign to: the viewer, marked "you", then `assignees`; Unassign), `TrackerMenu` (Track issue: Create GitHub issue, only
  for a github.com `repo_url`, `<repo>/issues/new` with title and body; Create Linear issue,
  `https://linear.app/new` with title and description; Link issue…, a dialog for the address; Unlink issue; a linked one is a button before it, named by its
  host) and `trackerText` (the title, then the culprit, the crashyard link and the top 5 frames, newest first).
  `LinkIssueDialog` is Link issue's, for Track and More. `ActionPrompt`: a notification link's Resolve, Ignore
  (until it escalates) or Assign to me (`?do=` on the issue page), asked once more in a dialog, or "It's already
  resolved." with Close; the dashboard's toasts. `IssueMoreMenu`, on a phone only: everything in the header
  but Resolve and Ignore, Priority and Assign to as submenus, the bookmark, the tracker's items, Unmerge… and both
  deletes.
- `priority.tsx`: `PriorityBadge`, an issue's priority as a badge (high red, medium amber, low muted) that opens a
  menu to change it, above a list row's link, 40 px on a phone; `PRIORITY_LABELS`.
- `event-view.tsx` (its grids `grid-cols-1`, a `minmax(0, 1fr)` column, so a long line scrolls inside it and never
  widens it over the issue's Tags, as Safari did with `auto`): an event as Sentry shows it: exception and stack (newest frame first, or oldest by the viewer's
  `stackOrder`, the crashing frame open; my code first, other frames folded unless `showOtherFrames`, context
  lines; a frame with a link, from `frameLinks` by its indexes in the event, has a button opening its line in the
  repository, 40 px on a phone; `Stack` folds a list of frames), then "Other threads" ("Threads" without an exception)
  folded: a row per thread with a stack, its name or id and top frame (its app's, else the innermost), opening to its
  stack; breadcrumbs, "Request" (method and URL, query string, headers as a two-column `Pairs` table, a name over its
  value on a phone, body), tags, contexts, "Additional data" (`extra` as `Pairs`), a line naming what was cut when the event was over its size budget
  (`_trimmed`), raw JSON (`RawEvent`, written only once opened, so an issue page's HTML doesn't carry it). Nested `<details>` use named groups (`group/threads`) so a chevron
  turns only with its own.
- `attachments.tsx`: an event's attachments, under its threads: each with its size and Download, an image (png, jpeg,
  gif, webp, `attachmentType`) as a 48 px thumbnail opening full size in a `Dialog`, and `view-hierarchy.json`
  (sentry-cocoa's and sentry-android's name for it) as an indented tree of type, identifier and frame, fetched when
  opened, 2000 views at most. Files come from `/attachments/<id>`.
- `sign-in.tsx`: the sign-in pages' pieces. `SignInFrame` (the mark and crashyard, then a card with a title and a
  line, alone in the middle of a muted page, `max-w-sm`), `auth` (a POST to `/auth/<path>`, its `error` thrown as
  the sentence to show), `createPasskey` and `signInWithPasskey` (`@simplewebauthn/browser`; a cancelled prompt,
  an existing passkey or an unusable browser in words), `nextPath` (from `src/lib/next.ts`: only a path on this site, read as a browser reads it, so `/\\evil.com` goes home), `RecoveryCodes` (two
  columns, Copy and Download as a text file), `Problem` (an error under a form), `GITHUB_ERRORS` (`?error=` from GitHub sign-in in words), `DemoCard` (the demo's `/signin`: Take a look around, Enter demo, a form POST to `/auth/demo` with `next`, the
  `claude mcp add` line for its `/mcp`, and Deploy your own crashyard), `Or` and `NewPerson` (setup and invite:
  the page's own fields, name, email or the invite's fixed one, Create passkey; then the recovery codes and
  Continue to crashyard, a whole page load; `alternative` under it, the invite's Join with GitHub).
- `settings.tsx`: the settings area's pages (`INSTANCE`, Notifications among them, `PROJECTS`, the open project's `PROJECT`: General,
  Connect, Stack traces, Events, Issues, Sentry, and `PERSONAL`), `SettingsNav` (the list: crashyard's pages, Projects, and
  while a project's page is open its name and pages indented under Projects, then You; with too little room beside
  the page, `@3xl/settings`, one `Select` of the same, labelled Settings page; no project picker of its own, the
  sidebar's filter is the only one), `useSettingsProject` (the project whose settings the path is), `pageOf` (a
  path's page name), `Subhead` (a heading over a few cards with an id to link to, Connect's Client keys), `Status` (a
  check's line, a tick or an amber warning, on Usage and Health), `SettingsCard`,
  `Hint`, `LimitInputs` (a project's limits and retention as form fields, also Defaults for new projects), `useSave` (runs
  a save, toasts Saved or the error, invalidates) and `SaveButton`.
- `push.tsx`: `usePushDevice` (this browser's state, Turn on and off), `PushHint`, `PushControls` (also in the push
  channel's dialog on Notifications) and `Push`, Preferences' card of them with whether a route sends to the viewer's
  channel; push notifications on the viewer's devices (`getPush`'s data as `push`: the VAPID key, the devices and
  their channel): this browser's state, read in the
  browser (no push API: on an iPhone or iPad outside the Home Screen app, how to add it, else that it can't; blocked;
  off; on), Turn on notifications (`subscribe`: permission asked first, straight from the tap, as Safari needs, then
  `/sw.js` registered and subscribed, `savePushDevice`; `Push` is nothing without a key, as in the demo), Send test notification (`testPush`, this device only), Turn
  off on this device, the devices with Remove, and whether a route sends to their channel. A subscription the server
  doesn't know is saved again on opening it, as a push service may move a browser to a new address (Safari fires no
  `pushsubscriptionchange`). `PushPrompt`, in `Layout`: once per device, in the installed app (`display-mode:
standalone`) with push and permission not asked yet, Get alerts on this device, Turn on notifications or Not now;
  either keeps `crashyard.push-prompted` in localStorage. No vite-plugin-pwa: its prompts are for a new service worker,
  not push, and it would replace `sw.js`.
- `new-version.tsx`: `NewVersion`, in `Layout`: an open page, an installed app above all, asks `/version.json` for
  the deployed build on coming back to the front and every 15 minutes (`vite.config.ts` writes it, and the same id
  into the page as `__BUILD__`); a different one shows A new version of crashyard is ready, with Reload and a close
  button, until closed. A dev server has no `version.json`, so it never shows there.
- `update.tsx`: `UpdateDialog`, for owners, loading `getUpdate` each time it opens: Automatically (Connect Cloudflare,
  an API token and the Worker's name, `crashyard` by default; once connected, Install <version> unless `refusal` says
  it needs a deploy, then a reload; the daily switch; the daily check's last failure; Disconnect), and Manually (the
  clone's three commands, the button copy's tag merge, the builder's Docker line when the update changes it, the
  upgrading guide). Installing from here needs Workers Paid, so on Free both are disabled with a line saying so.
- `markdown.tsx`: `Markdown` (no library: paragraphs, line breaks, `**bold**`, http and https links, lists of `-`,
  `*` or `1.`; nothing else, as React elements, no HTML), for markdown widgets and status page posts.
- `plan.tsx`: `usePlan` (the Workers plan from `getPlan` after the page loads, undefined meanwhile, null when it
  couldn't be found; `recheck`) `PaidNote`, the amber note, for `/setup`, which has the plan from its loader; and `NeedsPaid`, that note shown only on Workers Free saying what doesn't work
  there (Debug files, Connect an app's Workers card, Import from Sentry).
- `release.tsx`: `AdoptionStage` (Adopted, Low adoption, Replaced) and `HealthBadge` (Healthy, or Unhealthy with the
  thresholds it crossed in its title).
- `monitor-form.tsx`: `MonitorForm`, adding or editing a monitor. An uptime check has its method (`UPTIME_METHODS`),
  headers as name and value rows with Add header, a body for POST, PUT and PATCH, the status and text it must
  contain, and assertions (a row each: status is one of, saying "Status codes separated by commas, such as 200,
  204.", header contains, JSON path equals) with Add assertion; the dialog is wider for it. A cron monitor its slug,
  schedule, grace period and runtime. Each input has the `min`, `max` or `maxLength` `saveMonitor` checks.
  `settings.tsx`'s `LimitInputs` likewise.
- `uploads.tsx`: `UploadSteps`, the variables sentry-cli reads and each SDK's upload steps as tabs, on Debug files; `size`.
- `new-project.tsx`, `linking.tsx` (the SDK snippets as tabs, `PlatformTabs`; `docs/linking.md` says the
  same, keep them in step). `Code`, its copyable block, is every DSN and snippet's (Client keys, Connect an app, Debug
  files, Source code, tokens): the copy button sits in its own column beside the text, which scrolls sideways, never
  under it.
