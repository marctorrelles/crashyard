# Routes

TanStack Start's file-based routes: the dashboard's pages. `routeTree.gen.ts` is generated (by the dev
server, the build, or `tsr generate`): never edit it.

- `__root.tsx`: the document. Light or dark follows the system (a script sets `.dark` before paint and when the system
  changes); there's no toggle. The viewport covers the notch (`viewport-fit=cover`). It also has the error and not-found
  pages. Its loader is the sidebar's (projects, the one last picked, folded or not, who's signed in) and its component
  is `Layout` (`src/components/shell.tsx`). The lists (`/`, dashboards and each dashboard, issues, releases,
  performance, logs) take the sidebar's project filter as `?project=`, every project's when there's none; a project's
  pages are titled by the page with the project under it. Each page gives `Shell` its breadcrumbs: the section, the
  project (a list narrowed to it, the overview's for settings), then the page (a list narrowed to a project ends at it).
- `index.tsx`: the overview: a banner when a newer crashyard is out, projects with their unresolved count, events in a
  day and a 14-day sparkline; then events yesterday (a whole UTC day, against the day before), unresolved, new issues in
  24 hours and monitors failing as numbers, events per day per project (stacked areas), issues new and resolved per day
  (bars side by side) and crash-free per release (`getOverviewCharts`, 30 days, loaded with the overview, narrowed by
  `?project=`); failing monitors, new issues.
- `dashboards/index.tsx`: the dashboards (name, widgets or that they can't be read, when saved and by whom), New
  dashboard (a name, then it opens in edit mode, `?edit=true`), and with none, Start with Crashes (`STARTER`).
  `dashboards/$dashboardId.tsx`: one dashboard over a range (`?range=`, the logs page's), narrowed by `?project=`
  (`getDashboard`, every widget's data in one call); its widgets in a grid of thirds (one column on a phone). Edit keeps
  a draft (name, widgets added, changed, moved, removed; the range is fixed meanwhile, a changed widget shows its
  preview) until Save writes the whole dashboard; Cancel drops it; Delete asks first. A chart's series or a table's
  value opens the logs or issues with the widget's query and that value.
- `issues/index.tsx`: the issues list. The search lives in the URL (`project`, `query`, `sort`, `page`, `days`); the
  search bar (`SearchBar`) and the status tabs rewrite the query. Over the list, events per day and level of the
  issues it matches for the last 14, 30 or 90 days (`?days=`, `getIssueChart`, loaded with the list), the period
  before as a dashed line. A row's project and release are menus to show only or exclude that value. Bulk resolve,
  ignore, merge and delete.
- `issues/$issueId.tsx`: one issue: actions, counts and a 90-day chart, the event (`?event=` to pick one, older and
  newer), tags' top values with their share (for a key the grammar can write, + and − open the project's unresolved
  issues with or without that value), events, feedback, activity and notes.
- `releases.tsx`: releases (crash-free sessions when the SDK sends them), a section per project for every project;
  `projects/$slug/releases/$release.tsx`: one release's commits since the one before (from set-commits, each opening on
  the repository when the project has one), and its diff against the one before.
- `performance.tsx`: transactions by p95 with a sparkline of it over the period and the change since the release
  before (`?days=1|30`), a section per project; `projects/$slug/performance/transaction.tsx` (`?name=`): p95 per hour
  (a line, gaps joined) over the count (bars, a second axis), by release, the slowest with their
  span waterfall and trace links.
- `projects/$slug/settings.tsx`: the DSN and how to link an app, uploads, the repository and how to send a release's
  commits, name, platform, quota, retention, new key, delete.
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
  Times in the browser's time once hydrated.
- `monitors/`: the monitors (status, schedule or URL, the last 30 results as bars), adding an uptime check or a cron
  monitor, and one monitor: its results or check-ins, how to check in, incidents, pause, edit, delete.
- `notifications.tsx`: channels (ntfy, email, webhook, quiet hours in the browser's time) and routes, with a test send.
- Times on a page are relative to the `now` its loader returns, so the server and the browser render the same text;
  anything in the browser's time zone renders in `<ClientOnly>`.
- Pages are behind Access (`src/server.ts`); `/api/*` never reaches Start (see `src/api/`).
- Data for a page comes from a server function (`src/fns.ts`) called in the loader; after a change,
  `router.invalidate()`.
