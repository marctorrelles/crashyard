-- Monitors: cron jobs that check in (Sentry's check-ins, from the SDKs or sentry-cli monitors run), and URLs the
-- worker checks. An incident opens when one fails enough times in a row, and closes when it's well again.
CREATE TABLE monitors (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                        -- cron: the slug the SDK checks in with
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- cron, uptime
  config TEXT NOT NULL,                      -- JSON. cron: { schedule, timezone, checkinMargin, maxRuntime };
                                             -- uptime: { url, method, expectedStatus, mustContain, intervalMinutes, timeoutMs }
  failure_threshold INTEGER NOT NULL DEFAULT 1, -- failures in a row that open an incident
  recovery_threshold INTEGER NOT NULL DEFAULT 1, -- successes in a row that close it
  status TEXT NOT NULL DEFAULT 'pending',    -- pending (nothing yet), ok, failing, paused
  failures INTEGER NOT NULL DEFAULT 0,       -- in a row, so far
  successes INTEGER NOT NULL DEFAULT 0,
  next_due INTEGER,                          -- cron: when a check-in is late (the next run plus the margin); uptime: the next check
  last_seen INTEGER,                         -- the last check-in, or the last check
  environment TEXT NOT NULL DEFAULT 'production',
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, slug)
);
CREATE INDEX monitors_due ON monitors (next_due) WHERE status != 'paused';

CREATE TABLE check_ins (
  id TEXT PRIMARY KEY,                       -- the SDK's check_in_id, or made up for missed and timed-out runs
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  status TEXT NOT NULL,                      -- in_progress, ok, error, missed, timeout
  started INTEGER NOT NULL,
  finished INTEGER,
  duration INTEGER,                          -- ms
  release TEXT,
  environment TEXT
);
CREATE INDEX check_ins_monitor ON check_ins (monitor_id, started DESC);
CREATE INDEX check_ins_open ON check_ins (status, started) WHERE status = 'in_progress';

CREATE TABLE uptime_results (
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,                            -- the HTTP status, or null when it didn't answer
  ms INTEGER,
  error TEXT,
  PRIMARY KEY (monitor_id, at)
) WITHOUT ROWID;

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  reason TEXT NOT NULL                       -- missed, error, timeout, or what the check found
);
CREATE INDEX incidents_monitor ON incidents (monitor_id, opened_at DESC);
