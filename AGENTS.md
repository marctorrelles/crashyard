# Working on crashyard

A Sentry-compatible crash, error and log reporter that runs as one Cloudflare Worker. Apps send with the official
Sentry SDKs; crashyard groups, stores, searches and notifies. The dashboard is TanStack Start (React, rendered on the
server) with shadcn/ui; data is in D1 (SQLite) and R2. This file holds what the whole repo shares; each part has its
own AGENTS.md for what's particular to it.

```sh
pnpm dev                 # http://localhost:3000, with local D1 and R2, signed in as dev@localhost
                         # (AUTH=crashyard SETUP_CODE=… pnpm dev to work on sign-in itself)
pnpm check               # lint, format, types, knip, tests, build: run it before every commit
pnpm test                # vitest, in seconds
pnpm seed                # a month of made-up crashes in the local database
pnpm cf-typegen          # worker-configuration.d.ts from wrangler.jsonc, after changing it
pnpm run deploy          # build, refuse a version older than the dashboard installed, apply migrations, deploy
```

Where things are:

- `src/server.ts`: the worker's entry (`main` in `wrangler.jsonc`: Start's default entry would skip the sign-in
  check). `fetch` answers `/api/*` itself (`src/api/`, which check their own keys), a status page's own domain (`/`
  sent to `/status/<slug>` and that page alone, signed out; anything else a 404; a status page to a visitor without
  cookies is cached a minute, `publicStatusPage`), `/auth/*` (passkeys, signing out),
  and sends everything else to Start for whoever is signed in; `tail` takes the runs of Workers naming crashyard in
  their `tail_consumers` (`src/api/tail.ts`); `scheduled` runs the cron every minute (monitors, held
  notifications, each job apart so one that throws doesn't stop the rest; its heartbeat first, `cron.last_run` in `settings`; hourly,
  slower releases; every 5 minutes at :02, :07…, metric alerts; Mondays at 07:00 UTC, each project's week; hourly at
  :15, retention; hourly at :20, auto-resolve and notification failures past 30 days; hourly at :25, escalation;
  daily from 03:40 UTC, the automatic update, where an owner turned it on; envelopes to try again last. A job of an hour or a week runs once in its period from its minute on (`claimRun`, `cron.job.<name>` in `settings`,
  one upsert), so a minute Cloudflare skipped or ran late is made up by the next, within a grace (a first deploy
  mid-week sends no week's summary). The jobs share one deadline, 40 seconds from the start, `CRON_BUDGET`: each takes
  what's left, and one with under 2 seconds left waits for the next minute). In local dev only, `/__dev/sql`,
  `/__dev/cron` and `/__dev/tail` let the end-to-end tests reach the database, run the cron and send Worker runs.
- `src/demo.ts`: the public demo's read-only mode, on only where a deployment's `vars` set `DEMO=1` (never a
  self-hoster's): `demoGate`, ahead of everything in `fetch`, and the refusal every changing server function gives
  there, and a minute's cache of GET server functions, as everyone there is one viewer (`src/auth/AGENTS.md`, Demo).
- `src/api/`: ingest and Sentry's upload API (`/api/0/`), outside sign-in, and the MCP server, inside (see its
  AGENTS.md).
- `src/ingest/`: envelopes, events, grouping, scrubbing, storing (see its AGENTS.md).
- `src/notify/`: routes (frequency, filters, a wait), metric alerts, channels (Telegram, email, webhooks), quiet hours
  (see its AGENTS.md).
- `src/auth/`: who's signed in: passkeys, Sign in with GitHub and sessions (see its AGENTS.md).
- `src/fns.ts`: the dashboard's server functions: input checks, who's signed in, then `src/data/`. Each one that
  changes something names the least role it needs (`.middleware([member])`, `src/auth/AGENTS.md`). A field a
  person types passes its label to `int` or `text`, so a refusal names it and what fits ("Event retention in days is
  a whole number from 1 to 3,650."), and its input carries the same `min`, `max` or `maxLength`; ids and other
  fields only a page sets keep the short "expected …". `src/start.ts` limits them to same-origin calls (CSRF).
- `src/data/`: the dashboard's SQL (see its AGENTS.md).
- `src/search/`: Sentry's search syntax, as SQL (see its AGENTS.md).
- `src/symbols/`: uploads and readable stacks (see its AGENTS.md).
- `src/update/`: whether a newer crashyard is out, and installing it from the dashboard (see its AGENTS.md).
- `src/monitors/`: cron check-ins, uptime checks, incidents (see its AGENTS.md).
- `src/performance/`: transactions and sessions, summarised at ingest (see its AGENTS.md).
- `symcache/`: Sentry's symbolic, in Rust, built to `src/symbols/symcache.wasm`, and natively for the SymCache
  builder's container, `symcache/Dockerfile` (see its AGENTS.md).
- `src/routes/`: pages and API routes, file-based (see its AGENTS.md).
- `src/components/`: shadcn/ui and our own components (see its AGENTS.md).
- `public/`: served as they are, before the worker and so signed out: `sw.js`, the service worker for push
  notifications (`src/notify/AGENTS.md`), the app's manifest and its icons (PNGs of
  `docs/images/logo.svg`, the 192 and 512 with rounded corners, the maskable 512 and the 180 Apple one square).
- `src/lib/`: small shared helpers (`cn`; `nextPath`, where sign-in goes after, a path on this site only).
- `migrations/`: D1 migrations, numbered (see its AGENTS.md).
- `test/`: tests that run the worker, with the real Sentry SDK (see its AGENTS.md).
- `docs/`: decisions, deploying, linking an app (see its AGENTS.md).
- `scripts/`: `pnpm seed` for a local database with data in it (see its AGENTS.md).
- `wrangler.jsonc`: the worker, D1 (`DB`), R2 (`FILES`), email (`EMAIL`), the cron and empty `vars`, generic so
  anyone can deploy it; a deployment's own domain and values are in the git-ignored `wrangler.local.json`,
  which `vite.config.ts` lays over it, and so is the optional SymCache builder's container (Workers Paid, Docker to
  deploy; `CONTAINERS=1 pnpm dev` runs it locally).
- `.github/`: CI (`pnpm check`), PR titles (Conventional Commits), CodeQL, Scorecard and release-please (the last
  three skip themselves while the repo is private: `release-please-config.json` and its manifest at the root; a
  release gets its build, `scripts/release-bundle.mjs`, and a line in its notes when it changes `symcache/`), issue
  and PR templates, Dependabot. Actions are pinned by commit SHA.
- `site/`: crashyard.dev, the landing page, static files on their own Worker (see its AGENTS.md).
- `tmp/`: plans and scratch notes, git-ignored. Never commit plans.

## Rules

- **Fail closed.** Signed out, the dashboard opens only its sign-in pages, and the status pages with the uptime
  checks someone chose to show and what the team posted, also on its own domain, which opens nothing else; with no one set up yet, only `/setup`, its setup code and
  the Workers plan. Anything that reads data checks who's asking, anything that changes it their role.
- **Be what the Sentry SDKs and sentry-cli expect.** When in doubt about a wire format, check what the real SDK sends
  and what Sentry answers; record what was checked, and against which version, in the part's AGENTS.md.
- **Commits:** one subject per commit, Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). No commit or
  pull request credits Claude, Opus or any AI: no `Co-Authored-By`, no "Generated with", no session links.
- **Docs move with code:** every change updates the AGENTS.md of the part it touches, in the same commit. A new part
  gets its own AGENTS.md, with a CLAUDE.md of `@AGENTS.md` beside it, and a line under "Where things are" here.
- **Tests are fast:** pure functions with fixtures; the few that run the worker keep under 30 seconds together.
- **Dependencies are few** and MIT-compatible; say why in the commit that adds one.
- **Writing:** everything a user reads follows the tone below.
- **UI:** shadcn/ui components, light and dark following the system or the viewer's choice, usable on a phone. Times
  through `src/components/time.tsx`. Look at every UI change in
  light and dark, on a phone and a desktop.

## Tone

What people read sounds like a careful product team wrote it: calm, direct and useful. That covers the app, its
alerts and error messages, the README, `docs/`, CONTRIBUTING.md, SECURITY.md and the GitHub templates. The AGENTS.md
files and code comments are for contributors and keep their own terse style.

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
- **Alerts read at a glance.** The issue or monitor as the title, then a line of facts joined by " · ": "myapp ·
  1.0 (10) · Reached 100 events".
- **Numbers carry their unit in words.** "Event retention in days", "Timeout in seconds", "up 50% on the week before".
- **Product words stay the same everywhere.** Issue, event, release, project, monitor, channel, route, alert,
  dashboard, widget, log, transaction.
