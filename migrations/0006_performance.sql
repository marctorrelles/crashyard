-- Performance, light: transactions summarised per project, name, release and hour (counts, errors and a duration
-- histogram, for percentiles), the slowest few kept whole as examples; sessions counted per day, for crash-free
-- rates. A release is '' when the SDK named none.
CREATE TABLE transaction_hours (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  release TEXT NOT NULL,
  hour INTEGER NOT NULL,                     -- ms, at the start of the hour
  count INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,         -- transactions whose status wasn't ok
  sum_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name, release, hour)
) WITHOUT ROWID;
CREATE INDEX transaction_hours_time ON transaction_hours (project_id, hour);

-- The histogram: one row per non-empty bucket (src/performance/histogram.ts)
CREATE TABLE transaction_buckets (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  release TEXT NOT NULL,
  hour INTEGER NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (project_id, name, release, hour, bucket)
) WITHOUT ROWID;
CREATE INDEX transaction_buckets_time ON transaction_buckets (project_id, hour);

-- The slowest ten of each transaction a day, with their spans
CREATE TABLE transaction_examples (
  id TEXT PRIMARY KEY,                       -- the event id
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  release TEXT NOT NULL,
  environment TEXT,
  day TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  duration INTEGER NOT NULL,                 -- ms
  status TEXT,
  trace_id TEXT,
  spans TEXT NOT NULL                        -- JSON: [{ op, description, start, duration, status, depth }], ms from the start
);
CREATE INDEX transaction_examples_slowest ON transaction_examples (project_id, name, day, duration DESC);

CREATE TABLE sessions_daily (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  release TEXT NOT NULL,
  environment TEXT NOT NULL,
  day TEXT NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  errored INTEGER NOT NULL DEFAULT 0,        -- ended with handled errors
  abnormal INTEGER NOT NULL DEFAULT 0,       -- killed, without a crash report (the app hung, the OS ended it)
  crashed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, release, environment, day)
) WITHOUT ROWID;

-- A transaction found slower in a release than in the one before, so it's told once
CREATE TABLE slower_releases (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  release TEXT NOT NULL,
  previous TEXT NOT NULL,
  p95 INTEGER NOT NULL,
  previous_p95 INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, name, release)
) WITHOUT ROWID;

ALTER TABLE projects ADD COLUMN daily_transaction_quota INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE project_days ADD COLUMN transactions INTEGER NOT NULL DEFAULT 0;
