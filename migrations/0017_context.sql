-- Context: users per release from sessions, deploys, web and mobile vitals, uptime and cron monitors per
-- environment, and a project's release health thresholds.

-- Who had a session, per release, environment and UTC day: the session's `did` as a salted SHA-256, never the id
-- itself; `crashed` is 1 once any of their sessions that day crashed. Crash-free users and active users read it
CREATE TABLE session_users_daily (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  release TEXT NOT NULL,
  environment TEXT NOT NULL,
  day TEXT NOT NULL,
  did_hash TEXT NOT NULL,
  crashed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, release, environment, day, did_hash)
) WITHOUT ROWID;
CREATE INDEX session_users_daily_day ON session_users_daily (project_id, day);

-- Deploys of a release, from sentry-cli `deploys new`
CREATE TABLE deploys (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  release TEXT NOT NULL,
  environment TEXT NOT NULL,
  name TEXT,
  url TEXT,
  started INTEGER,                           -- ms, null when the deploy named no start
  finished INTEGER NOT NULL                  -- ms
);
CREATE INDEX deploys_release ON deploys (project_id, release, finished DESC);

-- Vitals from transactions' measurements, as histograms of the same buckets as transaction_buckets
-- (src/performance/histogram.ts): ms for timings, CLS times 1000, frame rates in hundredths of a percent
CREATE TABLE vital_buckets (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,                        -- the transaction
  release TEXT NOT NULL,
  hour INTEGER NOT NULL,
  vital TEXT NOT NULL,                       -- lcp, inp, cls, ttfb, fcp, app_start_cold, … (src/performance/vitals.ts)
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (project_id, vital, name, release, hour, bucket)
) WITHOUT ROWID;
CREATE INDEX vital_buckets_time ON vital_buckets (project_id, hour);

-- A cron monitor's state in each environment it checks in from
CREATE TABLE monitor_environments (
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,                      -- ok, failing, in_progress
  last_check_in INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, environment)
) WITHOUT ROWID;
-- The trace of a check-in, so errors in the same trace show on the monitor as "Errors during this job"
ALTER TABLE check_ins ADD COLUMN trace_id TEXT;
CREATE INDEX check_ins_trace ON check_ins (monitor_id, trace_id) WHERE trace_id IS NOT NULL;
-- When the cron muted a monitor that had been failing for 14 days; null while it isn't muted
ALTER TABLE monitors ADD COLUMN muted_at INTEGER;

-- Release health: a release is healthy with crash-free sessions at least this (a fraction, 0.995) and at most this many
-- new issues; null is no threshold
ALTER TABLE projects ADD COLUMN release_crash_free_min REAL;
ALTER TABLE projects ADD COLUMN release_new_issues_max INTEGER;
