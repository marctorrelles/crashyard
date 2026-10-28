# Scripts

- `setup.mjs` (`pnpm run setup`): a deployment from a clone: asks for its domain and email, writes
  `wrangler.local.json` (keeping what's there as the defaults), then offers to deploy, makes a setup code for the first
  owner's passkey (put as the worker secret `SETUP_CODE` and printed) and adds the R2 lifecycle rules (envelopes 30
  days, failed envelopes 30, chunks 1; attachments are pruned by the cron at their project's retention). Answers can be piped in.
- `recovery-code.mjs` (`pnpm run recovery-code <email>`, `--local` for dev): a one-time recovery code for someone
  who lost every passkey and code, inserted as `src/data/people.ts` stores them (SHA-256 of the code without its
  dash) through `wrangler d1 execute`, `RETURNING` to tell an unknown email. Whoever has the Cloudflare account is
  the root of trust; the code is used at `/signin`, Use a recovery code.
- `seed.mjs` (`pnpm seed`): fills the local dev database with a month of made-up crashes from three apps, through
  ingest's own code (normalise, fingerprint, store) and `src/data/`, with a regression, an ignored issue, a note, a
  week of transactions (one made slower by the newest release), two weeks of sessions, monitors, a channel and a route. Wipes local projects first; it only ever opens `.wrangler/state`. Use it to look at the
  dashboard, and for screenshots.
