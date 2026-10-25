# Working on crashyard

A Sentry-compatible crash, error and log reporter that runs as one Cloudflare Worker. Apps send with the official
Sentry SDKs; crashyard groups, stores, searches and notifies. The dashboard is TanStack Start (React, rendered on the
server) with shadcn/ui; data is in D1 (SQLite) and R2. This file holds what the whole repo shares; each part has its
own AGENTS.md for what's particular to it.

```sh
pnpm dev                 # http://localhost:3000, with local D1 and R2 (Access is off locally)
pnpm check               # lint, format, types, knip, tests, build: run it before every commit
pnpm test                # vitest, in seconds
pnpm cf-typegen          # worker-configuration.d.ts from wrangler.jsonc, after changing it
pnpm run deploy          # build, apply migrations to the remote D1, deploy
```

Where things are:

- `src/server.ts`: the worker's entry (`main` in `wrangler.jsonc`: Start's default entry would skip the Access check). `fetch` sends `/api/*` straight to Start (those routes check their own keys) and
  everything else through Cloudflare Access first; `scheduled` runs the cron jobs.
- `src/auth/`: the Access check (see its AGENTS.md).
- `src/routes/`: pages and API routes, file-based (see its AGENTS.md).
- `src/components/`: shadcn/ui and our own components (see its AGENTS.md).
- `src/lib/`: small shared helpers (`cn`).
- `migrations/`: D1 migrations, numbered (see its AGENTS.md).
- `docs/`: decisions, deploying, linking an app (see its AGENTS.md).
- `wrangler.jsonc`: the worker, its domain, D1 (`DB`), R2 (`FILES`), the cron and the Access config.
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
- **UI:** shadcn/ui components, light and dark following the system, usable on a phone. Look at every UI change in
  light and dark, on a phone and a desktop.
