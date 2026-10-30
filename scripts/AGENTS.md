# Scripts

- `setup.mjs` (`pnpm run setup`): a deployment from a clone: asks for its domain and email, writes
  `wrangler.local.json` (keeping what's there as the defaults), then offers to deploy, makes a setup code for the first
  owner's passkey (put as the worker secret `SETUP_CODE` and printed) and adds the R2 lifecycle rules (envelopes 30
  days, failed envelopes 30, chunks 1; attachments are pruned by the cron at their project's retention). Answers can be piped in.
- `recovery-code.mjs` (`pnpm run recovery-code <email>`, `--local` for dev): a one-time recovery code for someone
  who lost every passkey and code, inserted as `src/data/people.ts` stores them (SHA-256 of the code without its
  dash) through `wrangler d1 execute`, `RETURNING` to tell an unknown email. Whoever has the Cloudflare account is
  the root of trust; the code is used at `/signin`, Use a recovery code. `--remote` (the default) runs on
  `-c dist/server/wrangler.json`, building first when it's missing.
- `release-bundle.mjs`: the release workflow's, after `pnpm build` without a `wrangler.local.json` (it refuses a
  build with routes or containers): `crashyard.json.gz`, dist/server's modules, dist/client's assets but the
  `.assetsignore`d, each in base64, the migrations' SQL, and from dist/server/wrangler.json the main module,
  compatibility, crons, assets config and the names of the bindings it needs (`src/update/install.ts` reads it).
- `deploy-guard.mjs`: in `pnpm run deploy` after the build: the D1 database created when there's none of its name, then
  `update.installed` read through `wrangler d1 execute`,
  and a deploy of an older version than the dashboard installed stopped, as it would undo it; no row or no
  answer goes ahead.
- Every remote `wrangler d1` command here, and the deploy's migrations, passes `-c dist/server/wrangler.json`: d1
  commands don't follow the build's config redirect as `wrangler deploy` does, and would read `wrangler.jsonc` alone,
  so a deployment that renames its database in `wrangler.local.json` would reach one called `crashyard` instead.
- `seed.mjs` (`pnpm seed`): fills the local dev database with a month of made-up crashes from three apps, through
  ingest's own code (normalise, fingerprint, store) and `src/data/`, with a regression, an ignored issue, a note, a
  week of transactions (one made slower by the newest release), two weeks of sessions, monitors, a channel and a route. Wipes local projects first; it only ever opens `.wrangler/state`. Use it to look at the
  dashboard, and for screenshots.
