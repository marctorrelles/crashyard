-- Dashboards: a name and its widgets (JSON, see src/data/dashboards.ts), shared by everyone signed in
CREATE TABLE dashboards (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  widgets TEXT NOT NULL,        -- JSON: Widget[]
  updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL      -- who saved it last (Access email)
);
CREATE INDEX dashboards_updated ON dashboards (updated DESC);
