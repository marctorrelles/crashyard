# Working on crashyard

A Sentry-compatible crash, error and log reporter that runs as one Cloudflare Worker. Apps send with the official
Sentry SDKs; crashyard groups, stores, searches and notifies. The dashboard is TanStack Start (React, rendered on the
server) with shadcn/ui; data is in D1 (SQLite) and R2. This file holds what the whole repo shares; each part has its
own AGENTS.md for what's particular to it.

```sh
pnpm dev                 # http://localhost:3000, with local D1 and R2 (Access is off locally)
pnpm check               # lint, format, types, knip, tests, build: run it before every commit
pnpm test                # vitest, in seconds
pnpm seed                # a month of made-up crashes in the local database
pnpm cf-typegen          # worker-configuration.d.ts from wrangler.jsonc, after changing it
pnpm run deploy          # build, apply migrations to the remote D1, deploy
```

Where things are:

- `src/server.ts`: the worker's entry (`main` in `wrangler.jsonc`: Start's default entry would skip the Access
  check). `fetch` answers `/api/*` itself (`src/api/`, which check their own keys) and sends everything else to Start
  through Cloudflare Access; `scheduled` runs the cron every minute (monitors, held notifications; hourly, slower
  releases; Mondays at 07:00 UTC, each project's week; at 03:00 UTC, retention). In local dev only, `/__dev/sql` and
  `/__dev/cron` let the end-to-end tests reach the database and run the cron.
- `src/api/`: ingest and Sentry's upload API (`/api/0/`), outside Access, and the MCP server,
  inside (see its AGENTS.md).
- `src/ingest/`: envelopes, events, grouping, scrubbing, storing (see its AGENTS.md).
- `src/notify/`: routes, channels (Telegram, email, webhooks), quiet hours (see its AGENTS.md).
- `src/auth/`: the Access check (see its AGENTS.md).
- `src/fns.ts`: the dashboard's server functions: input checks, who's signed in, then `src/data/`.
  `src/start.ts` limits them to same-origin calls (CSRF).
- `src/data/`: the dashboard's SQL (see its AGENTS.md).
- `src/search/`: Sentry's search syntax, as SQL (see its AGENTS.md).
- `src/symbols/`: uploads and readable stacks (see its AGENTS.md).
- `src/monitors/`: cron check-ins, uptime checks, incidents (see its AGENTS.md).
- `src/performance/`: transactions and sessions, summarised at ingest (see its AGENTS.md).
- `symcache/`: Sentry's symbolic, in Rust, built to `src/symbols/symcache.wasm` (see its AGENTS.md).
- `src/routes/`: pages and API routes, file-based (see its AGENTS.md).
- `src/components/`: shadcn/ui and our own components (see its AGENTS.md).
- `src/lib/`: small shared helpers (`cn`).
- `migrations/`: D1 migrations, numbered (see its AGENTS.md).
- `test/`: tests that run the worker, with the real Sentry SDK (see its AGENTS.md).
- `docs/`: decisions, deploying, linking an app (see its AGENTS.md).
- `scripts/`: `pnpm seed` for a local database with data in it (see its AGENTS.md).
- `wrangler.jsonc`: the worker, D1 (`DB`), R2 (`FILES`), email (`EMAIL`), the cron and empty `vars`, generic so
  anyone can deploy it; a deployment's own domain and Access values are in the git-ignored `wrangler.local.json`,
  which `vite.config.ts` lays over it.
- `.github/`: CI (`pnpm check`), PR titles (Conventional Commits), CodeQL, Scorecard and release-please (the last
  three skip themselves while the repo is private: `release-please-config.json` and its manifest at the root), issue
  and PR templates, Dependabot. Actions are pinned by commit SHA.
- `tmp/`: plans and scratch notes, git-ignored. Never commit plans.

## Rules

- **Fail closed.** The dashboard is behind Access, and the worker checks Access's token itself; without Access
  configured, a deployment refuses every dashboard request. Anything that reads data checks who's asking.
- **Be what the Sentry SDKs and sentry-cli expect.** When in doubt about a wire format, check what the real SDK sends
  and what Sentry answers; record what was checked, and against which version, in the part's AGENTS.md.
- **Commits:** one subject per commit, Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). No commit or
  pull request credits Claude, Opus or any AI: no `Co-Authored-By`, no "Generated with", no session links.
- **Docs move with code:** every change updates the AGENTS.md of the part it touches, in the same commit. A new part
  gets its own AGENTS.md, with a CLAUDE.md of `@AGENTS.md` beside it, and a line under "Where things are" here.
- **Tests are fast:** pure functions with fixtures; the few that run the worker keep under 30 seconds together.
- **Dependencies are few** and MIT-compatible; say why in the commit that adds one.
- **Writing:** everything a user reads follows the tone below.
- **UI:** shadcn/ui components, light and dark following the system, usable on a phone. Look at every UI change in
  light and dark, on a phone and a desktop.

## Tone

What people read, in the app, in its alerts, in error messages and in the README, sounds like a careful product team
wrote it: calm, direct and useful. `docs/` pages move to it as they're edited. These AGENTS.md files and code comments
are for contributors and keep their own terse style.

- **Plain sentences.** Sentence case, short sentences, everyday words. No parentheses and no semicolons: split the
  thought into two sentences, or drop the aside.
- **Say what it is, not how it's built.** "Daily event limit", not "events a day quota". "Symbols and source maps", not
  "readable stacks".
- **Buttons and menus say what happens.** A verb and its object: "Create token", "Add uptime check", "Resolve in next
  release". The same action keeps the same name in its button, its confirmation and its toast.
- **Errors say what happened and what to do.** "That isn't a bot token. Copy the token from @BotFather, it looks like
  123456789:AA…", not "Telegram answered 404". No apologies, no blame, no bare status codes.
- **Confirmations say what will be lost.** "Delete Crashes and all its widgets? This can't be undone."
- **Empty states invite the next step.** A title naming what's missing, one line saying how it fills, and the action
  when there is one. One touch of light humour or reassurance at most, and only where nothing is wrong: "Not a single
  open issue. Enjoy it while it lasts." Never joke about a failure.
- **Alerts read at a glance.** The issue or monitor as the title, then a line of facts joined by " · ": "pocketband ·
  1.0 (10) · Reached 100 events".
- **Numbers carry their unit in words.** "Event retention in days", "Timeout in seconds", "up 50% on the week before".
- **Product words stay the same everywhere.** Issue, event, release, project, monitor, channel, route, alert,
  dashboard, widget, log, transaction.
