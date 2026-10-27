-- Every event of an issue per minute, kept or only counted by spike protection, so a frequency route's window counts
-- them all, exact to the minute (src/notify/rules.ts). One upsert in storeEvent's batch; pruned after a day. No
-- backfill: windows read from the events stored from now on
CREATE TABLE issue_minutes (
  issue_id INTEGER NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  minute INTEGER NOT NULL, -- minutes since 1970
  count INTEGER NOT NULL,
  PRIMARY KEY (issue_id, minute)
) WITHOUT ROWID;

-- When the route's frequency last fired for the issue, the event's received time in ms; null when it never has.
-- Apart from `at`, the route's wait, which every kind of alert sets
ALTER TABLE route_fires ADD COLUMN frequency_at INTEGER;
