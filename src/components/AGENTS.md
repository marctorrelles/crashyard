# Components

- `ui/`: shadcn/ui (style `radix-nova`, neutral, `components.json` at the root). Added with
  `yes n | pnpm dlx shadcn@latest add <name>` (the `n` keeps the files it would overwrite); kept as upstream writes
  them, so they can be re-added with `--overwrite`. After adding one, fix its `cn` import to `@/lib/utils` if the CLI
  wrote `"cn"` (and `pnpm remove cn` if it added that package). The theme's colours are in `src/styles.css`.
- Icons are Tabler's (`@tabler/icons-react`, `IconName`; `components.json`'s `iconLibrary` is `tabler`, so re-added
  shadcn components come with them too), brands included (`IconBrandSlack`, …). No other icon set.
- Our own components sit beside `ui/`, built from those. Every one works on a phone (touch targets of 40 px or more,
  nothing wider than the screen) and in light and dark.
- `shell.tsx`: `Layout` (the root's: shadcn's `Sidebar`, kept between pages: the project filter on top, then the same
  pages whatever's picked, Overview, Dashboards, Issues, Releases, Performance, Logs, Monitors, Notifications, and at
  the foot who's signed in with Sign out, Access's `/cdn-cgi/access/logout`), `Shell` (a page: the top bar with the
  sidebar's toggle and the page's `crumbs`, section down to the page, a phone showing the last two; then its width,
  `wide` for lists), `PageHeader`, `Empty` (shadcn's Empty: an icon, a title, one line and an optional action; `compact` inside a
  section), `useProjects`. The lists (overview, dashboards, issues, releases, performance, logs)
  take the filter as `?project=` (on a dashboard, picking a project keeps it and its range); the project shown comes
  from that, `/projects/$slug` or an issue's own; pages of no project keep the one last picked (cookie
  `crashyard_project`, read back by the root's loader, like shadcn's `sidebar_state`). The filter's menu also has the
  picked project's settings.
- `bits.tsx`: `Sparkline` (SVG bars, no chart library; `label` for what they are when not events per day), `Ago`
  (relative to a `now` from the loader), `Level`, `count`, `percent`.
- `performance.tsx`: `ms` (a duration), `Period` and `Waterfall` (spans as
  bars, indented by depth; on a phone the bar goes under its name).
- `search-bar.tsx`: `SearchBar` (scope issues or logs): every `key:value` of the query is a pill (key, operator
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
  and typed text) on every change. On the issues and logs pages, and in the widget dialog.
- `charts.tsx`: shadcn's `ChartContainer` over recharts. `TimeChart`: counts per bucket (`x` is bucket starts in ms or
  UTC days `YYYY-MM-DD`), series stacked as bars or areas (lines aren't; `stacked={false}` puts bars side by side), a
  series' own `kind` and `axis: 'right'` (a second axis, `formatRight`; the transaction page's count under its p95),
  null values skipped in a line (joined across), `legend`, `onSeries` (a click on a series' bar, area or line, with a
  fine pointer only, `useFinePointer` in `src/hooks/`: on touch a tap shows the tooltip, and the table or legend drill
  in), `previous` (the period before) as a dashed line in the text's colour, faded, a tooltip per bucket, and with
  `onZoom` a drag across it gives the buckets' exact span (the logs page zooms with it). Days are written as the UTC day
  they are; hours in the browser's time, and over two days or more of hours a tick a day with its date (over less, a
  tick that starts a day says its date); it draws inside `<ClientOnly>`, a `Skeleton` of its size before. Colours: a
  series' own, else `LEVEL_COLORS` by key, the same as `Level`'s dots (fatal red 600, error orange 500, warning and
  logs' warn amber 400, info sky 500, debug zinc 400, logs' trace fainter), else the theme's `--chart-n`; `PALETTE`, 8
  colours for groups and projects. `BarList`: values with a bar for their share, count and percent (or `format`'s text),
  - (show only) and − (exclude) on hover, always shown on touch. `BigNumber`: a number, its label and its change (more
    reads red, less green, none as rounded muted), on the overview and dashboards.
- `widget.tsx`: a dashboard's widget. `WidgetCard` (title, dataset and group-by unless the title says just that,
  query, then the number with its change, at its own height beside a taller widget, the chart, the table of values with their change, the issues, or what went wrong, a placeholder saying it can't be
  read and to remove or redo it; a series or a value opens the logs or issues with it added), `WidgetActions` (edit
  mode: edit, up, down, remove; 40 px on a phone) and `WidgetDialog` (title, dataset, `SearchBar` of its scope (what's
  in it is saved on Add, searched or not, by its `onChange`; a placeholder redone is valid again), display
  `ToggleGroup`, group-by, width, and a preview from `previewWidget` 400 ms after a change, a reply for an older widget
  never shown).
- `value-menu.tsx`: `ValueMenu`, a value on a page as a `DropdownMenu`: show only this, exclude this, copy. Pages pass
  `addValue` for the first two, only for a key the grammar can write (`isSearchableKey`); its trigger sits above a row's
  link (`z-10`), its tap area 40 px high on a phone.
- `issue-actions.tsx`: resolve, ignore, reopen, merge, delete, for one issue or a selection.
- `event-view.tsx`: an event as Sentry shows it: exception and stack (my code first, other frames folded, context
  lines; a frame with a link, from `frameLinks` by its indexes in the event, has a button opening its line in the
  repository, 40 px on a phone; `Stack` folds a list of frames), then "Other threads" ("Threads" without an exception)
  folded: a row per thread with a stack, its name or id and top frame (its app's, else the innermost), opening to its
  stack; breadcrumbs, "Request" (method and URL, query string, headers as a two-column `Pairs` table, a name over its
  value on a phone, body), tags, contexts, "Additional data" (`extra` as `Pairs`), raw JSON. Nested `<details>` use named groups (`group/threads`) so a chevron
  turns only with its own.
- `attachments.tsx`: an event's attachments, under its threads: each with its size and Download, an image (png, jpeg,
  gif, webp, `attachmentType`) as a 48 px thumbnail opening full size in a `Dialog`, and `view-hierarchy.json`
  (sentry-cocoa's and sentry-android's name for it) as an indented tree of type, identifier and frame, fetched when
  opened, 2000 views at most. Files come from `/attachments/<id>`.
- `new-project.tsx`, `linking.tsx` (the SDK snippets per platform; `docs/linking.md` says the
  same, keep them in step).
