# Routes

TanStack Start's file-based routes: the dashboard's pages. `routeTree.gen.ts` is generated (by the dev
server, the build, or `tsr generate`): never edit it.

- `__root.tsx`: the document. Light or dark follows the system (a script sets `.dark` before paint and when the system
  changes); there's no toggle. The viewport covers the notch (`viewport-fit=cover`).
  It also has the error and not-found pages.
- `index.tsx`: home: projects with their unresolved count, events in a day and a 14-day sparkline; new issues.
- `issues/index.tsx`: the issues list. The search lives in the URL (`project`, `query`, `sort`, `page`); the status
  tabs rewrite `is:` in the query. Bulk resolve, ignore, merge and delete.
- `issues/$issueId.tsx`: one issue: actions, counts and a 90-day chart, the event (`?event=` to pick one, older and
  newer), tags' top values (each a search), events, feedback, activity and notes.
- `projects/$slug/releases/`: a project's releases (crash-free sessions when the SDK sends them), and one release's
  diff against the one before.
- `projects/$slug/performance/`: transactions by p95 with the change since the release before (`?days=1|30`), and one
  transaction (`transaction?name=`): p95 per hour, by release, the slowest with their span waterfall and trace links.
- `projects/$slug/settings.tsx`: the DSN and how to link an app, name, platform, quota, retention, new key, delete.
- `logs.tsx`: the logs explorer: search, time range, facets (folded on a phone), click a line for every attribute
  and its trace's logs and issues, Live (polls every 2 s for newer), Older. Times in the browser's time once hydrated.
- `monitors/`: the monitors (status, schedule or URL, the last 30 results as bars), adding an uptime check or a cron
  monitor, and one monitor: its results or check-ins, how to check in, incidents, pause, edit, delete.
- `notifications.tsx`: channels (ntfy, email, webhook, quiet hours in the browser's time) and routes, with a test send.
- Times on a page are relative to the `now` its loader returns, so the server and the browser render the same text;
  anything in the browser's time zone renders in `<ClientOnly>`.
- Pages are behind Access (`src/server.ts`); `/api/*` never reaches Start (see `src/api/`).
- Data for a page comes from a server function (`src/fns.ts`) called in the loader; after a change, `router.invalidate()`.
