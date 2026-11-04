-- Envelopes held while they're processed, and those waiting for the cron's retry (src/ingest/retry.ts), when the body
-- is UTF-8 text small enough for a row: one row written to hold it and one to drop it, instead of an R2 class A write.
-- Bodies over HOLD_IN_D1_MAX, or binary ones (minidumps, images), stay in R2 under the same key. Text, not a BLOB, as
-- D1 carries a BLOB both ways as an array of numbers. Keyed by (received, key) and no other index: the cron reads the
-- oldest first from the key's start, never the whole table, and no index writes a row more each time.
CREATE TABLE held_envelopes (
  received INTEGER NOT NULL, -- ms, when the request came
  key TEXT NOT NULL, -- pending/<project>/<received ms>-<16 hex>, as in R2: it seeds stable event ids
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL, -- envelope or store
  attempts INTEGER NOT NULL DEFAULT 1, -- tries started, the request's first
  items TEXT, -- item indexes still to do, comma-separated (`3`, `3:2`); null for every kept item
  leased_until INTEGER, -- ms, a cron run's claim while it tries the envelope
  body TEXT NOT NULL, -- the envelope as it came, decompressed; last, so the cron's scan never reads it
  PRIMARY KEY (received, key)
) WITHOUT ROWID;
