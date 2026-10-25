# Components

- `ui/`: shadcn/ui (style `radix-nova`, neutral, `components.json` at the root). Added with
  `yes n | pnpm dlx shadcn@latest add <name>` (the `n` keeps the files it would overwrite); kept as upstream writes
  them, so they can be re-added with `--overwrite`. After adding one, fix its `cn` import to `@/lib/utils` if the CLI
  wrote `"cn"` (and `pnpm remove cn` if it added that package). The theme's colours are in `src/styles.css`.
- Our own components sit beside `ui/`, built from those. Every one works on a phone (touch targets of 40 px or more,
  nothing wider than the screen) and in light and dark.
- `shell.tsx`: `Layout` (the root's: shadcn's `Sidebar`, kept between pages: the project filter on top, then the same
  pages whatever's picked, Overview, Issues, Releases, Performance, Logs, Monitors, Notifications, and at the foot who's
  signed in with Sign out, Access's `/cdn-cgi/access/logout`), `Shell` (a page's width, `wide` for lists),
  `PageHeader`, `Empty`, `useProjects`. The lists (overview, issues, releases, performance, logs) take the filter as
  `?project=`; the project shown comes from that, `/projects/$slug` or an issue's own; pages of no project keep the one
  last picked (cookie `crashyard_project`, read back by the root's loader, like shadcn's `sidebar_state`). The
  filter's menu also has the picked project's settings.
- `bits.tsx`: `Sparkline` (SVG bars, no chart library), `Ago` (relative to a `now` from the loader), `Level`, `count`,
  `percent`.
- `performance.tsx`: `ms` (a duration), `Period`, `P95Chart` (p95 and count per hour, SVG) and `Waterfall` (spans as
  bars, indented by depth; on a phone the bar goes under its name).
- `search-bar.tsx`: `SearchBar` (scope issues or logs): every `key:value` of the query is a pill (a `ButtonGroup`:
  key, operator menu, value, ×; the key or value turns it back into text with the value selected), free words stay
  in the input. A popover (`Popover` anchored on the bar, its width; `Command`, unfiltered, highlighted from the input)
  proposes what `src/search/suggest.ts` says for the caret. ↑ ↓ move, Enter picks what's highlighted or else searches
  (nothing is highlighted until an arrow is pressed, so a plain search never loses its Enter), Tab picks the first or
  highlighted, Esc closes, Backspace on an empty input turns the last pill back into text. Picking a value makes a
  pill and searches; changing or removing a pill searches. Keys come once on focus and values 150 ms after typing
  stops, from `getSuggestions`, cached by scope, project, range, key and prefix for the page's life (a late reply only
  fills its own entry; while one is on its way, a shorter prefix's narrows). Not on a page yet: it's a knip entry in
  `knip.json` until the issues and logs pages use it (then take it out).
- `issue-actions.tsx`: resolve, ignore, reopen, merge, delete, for one issue or a selection.
- `event-view.tsx`: an event as Sentry shows it: exception and stack (my code first, other frames folded, context
  lines), breadcrumbs, tags, contexts, raw JSON.
- `new-project.tsx`, `linking.tsx` (the SDK snippets per platform; `docs/linking.md` says the
  same, keep them in step).
