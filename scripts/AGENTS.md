# Scripts

- `setup.mjs` (`pnpm run setup`): a deployment from a clone: asks for its domain and email, writes
  `wrangler.local.json` (keeping what's there as the defaults), then offers to deploy, makes a setup code for the first
  owner's passkey (put as the worker secret `SETUP_CODE` and printed) and adds the R2 lifecycle rules (failed envelopes
  30 days, chunks 1; attachments are pruned by the cron at their project's retention). Answers can be piped in.
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
  week of transactions (one made slower by the newest release), two weeks of sessions, monitors, a channel and a route, and eight weeks of actions from pocketband's and notes web's users, each with a platform, OS, device or browser, country and a plan (a wav export crashes now and then, more on 1.0 (10), in the same trace, and those who crash in their first week come back less; notes web's landing page names no user), and a saved funnel, Export. Wipes local projects first; it only ever opens `.wrangler/state`. Use it to look at the
  dashboard, and for screenshots.
- `demo/wrangler.json`: the public demo's overlay (`CRASHYARD_OVERLAY=scripts/demo/wrangler.json pnpm build`): Worker
  `crashyard-demo` on demo.crashyard.dev and demo-status.crashyard.dev, D1 `crashyard-demo`, R2
  `crashyard-demo-files`, `DEMO=1`. `demo/preflight.mjs` refuses a dist/server/wrangler.json naming anything else, or
  with containers or Durable Objects, before any remote command.
- `demo-deploy.sh`: the demo's deploy in the account `wrangler whoami` shows, in order: the demo build and preflight,
  R2 and its lifecycle rules, D1 and migrations (deploy-guard), the Worker, then from the crashyard-demo checkout
  (`DEMO_DIR`, `../crashyard-demo`) brightpan-edge and brightpan-shop on workers.dev, seed step 1 (its tokens kept in
  that checkout's git-ignored `feeder/.secrets.json`), the recorded debug files (the web builds' source maps, the iPhone app's dSYMs, the Android app's R8 mappings), the corpus, the feed secret (`FEED_SECRET` on both Workers, kept in `.secrets.json`), and the
  feeder with its tokens as secrets; `after-backfill` runs seed step 2 once the feeder has caught up. Every remote
  command passes `-c`: the demo build for crashyard's, each sample Worker's own for the rest; the seed writes its own
  config naming `crashyard-demo` alone.
