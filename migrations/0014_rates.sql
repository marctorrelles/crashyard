-- Alerts on rates: events per issue and hour, routes that fire on a frequency with filters and a wait between alerts,
-- metric alerts and escalation.

-- Events per issue and hour, by level, release and environment, written at ingest in storeEvent's batch (every event,
-- those spike protection counts without keeping too). Metric alerts and escalation read it. Pruned with the events
CREATE TABLE event_hours (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,                  -- ms, the hour's start
  level TEXT NOT NULL,
  release TEXT NOT NULL DEFAULT '',       -- '' when the event named none
  environment TEXT NOT NULL DEFAULT '',   -- '' when the event named none
  count INTEGER NOT NULL,
  PRIMARY KEY (issue_id, hour, level, release, environment)
) WITHOUT ROWID;
CREATE INDEX event_hours_project_hour ON event_hours (project_id, hour);
CREATE INDEX event_hours_hour ON event_hours (hour);
-- From the events kept: those spike protection didn't keep were never stored, so they aren't here either
INSERT INTO event_hours (project_id, issue_id, hour, level, release, environment, count)
SELECT project_id, issue_id, received / 3600000 * 3600000, level, COALESCE(release, ''), COALESCE(environment, ''),
  COUNT(*)
FROM events GROUP BY 1, 2, 3, 4, 5, 6;

-- The user an event came from, hashed as in issue_users, for "N users in a window"; null for events stored before
ALTER TABLE events ADD COLUMN user_hash TEXT;

-- Routes: a frequency alert, filters, and a wait before the same route alerts on the same issue again
ALTER TABLE routes ADD COLUMN frequency TEXT;  -- JSON { events?, users?, minutes: 5|10|30|60|1440 }, null for none
ALTER TABLE routes ADD COLUMN releases TEXT;   -- JSON list of globs (1.2.*), null for every release
ALTER TABLE routes ADD COLUMN query TEXT;      -- tag filters in search syntax (os:iOS !device:iPad*), null for none
ALTER TABLE routes ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 0; -- 0: every time

-- When each route last alerted on each issue, for interval_minutes
CREATE TABLE route_fires (
  route_id INTEGER NOT NULL REFERENCES routes (id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  at INTEGER NOT NULL, -- ms
  PRIMARY KEY (route_id, issue_id)
) WITHOUT ROWID;

-- A number watched every 5 minutes over a window, alerting when it crosses its warning or critical value and when it
-- comes back (src/notify/metrics.ts)
CREATE TABLE metric_alerts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,        -- errors, users, crash_free_sessions, p95, failure_rate, log_count
  query TEXT NOT NULL DEFAULT '', -- search syntax: environment and release, attributes for logs
  window_hours INTEGER NOT NULL, -- 1, 6 or 24
  direction TEXT NOT NULL,     -- above, below
  warning REAL,                -- null for none; percent for rates, ms for p95
  critical REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'ok', -- ok, warning, critical
  value REAL,                  -- the last value read, null when there was nothing to read
  changed_at INTEGER,          -- ms, when the state last changed
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX metric_alerts_project ON metric_alerts (project_id);

-- Escalating issues, which the hourly check looks through to turn back to ongoing
CREATE INDEX issues_escalating ON issues (id) WHERE substatus = 'escalating';
-- Ignored until this many users: the user count that ends it
ALTER TABLE issues ADD COLUMN ignore_until_users INTEGER;
