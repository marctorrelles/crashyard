# Scripts

- `setup.mjs` (`pnpm run setup`): a deployment from a clone: asks for its domain, Access and email values, writes
  `wrangler.local.json` (keeping what's there as the defaults), then offers to deploy and add the R2
  lifecycle rules (envelopes 30 days, attachments 90, chunks 1). Answers can be piped in.
- `seed.mjs` (`pnpm seed`): fills the local dev database with a month of made-up crashes from three apps, through
  ingest's own code (normalise, fingerprint, store) and `src/data/`, with a regression, an ignored issue, a note, a
  week of transactions (one made slower by the newest release), two weeks of sessions, monitors, a channel and a route. Wipes local projects first; it only ever opens `.wrangler/state`. Use it to look at the
  dashboard, and for screenshots.
