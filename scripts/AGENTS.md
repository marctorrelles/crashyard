# Scripts

- `seed.mjs` (`pnpm seed`): fills the local dev database with a month of made-up crashes from three apps, through
  ingest's own code (normalise, fingerprint, store) and `src/data/`, with a regression, an ignored issue, a note, a
  week of transactions (one made slower by the newest release), two weeks of sessions, monitors, a channel and a route. Wipes local projects first; it only ever opens `.wrangler/state`. Use it to look at the
  dashboard, and for screenshots.
