-- Logs per project, hour and level: what the logs chart and level/project groups read for spans of an hour or more
CREATE TABLE log_hours (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,        -- the hour's start, ms
  level TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (project_id, hour, level)
) WITHOUT ROWID;
CREATE INDEX log_hours_hour ON log_hours (hour);
INSERT INTO log_hours (project_id, hour, level, count)
  SELECT project_id, timestamp - timestamp % 3600000, level, COUNT(*) FROM logs GROUP BY 1, 2, 3;

-- Issues resolved per day (the overview) and the issues chart of every project read these by time
CREATE INDEX IF NOT EXISTS issue_activity_kind_at ON issue_activity (kind, at);
CREATE INDEX IF NOT EXISTS issue_days_day ON issue_days (day);
