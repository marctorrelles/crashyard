-- Dashboards v2: the widget lists a dashboard had before each save, to look back on and restore, and saved searches.
-- Widgets stored in the first shape stay as they are: readWidgets upgrades them when it reads them.

-- JSON, newest first, 10 at most: [{ widgets, by, at }], `widgets` as it was stored (either shape)
ALTER TABLE dashboards ADD COLUMN revisions TEXT NOT NULL DEFAULT '[]';

-- A search someone named, on the issues, logs or explore page; theirs alone unless shared, and the pinned one opens
-- by default for them
CREATE TABLE saved_searches (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,                       -- who saved it (Access email)
  page TEXT NOT NULL,                        -- issues, logs, explore
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,         -- 1 for at most one a page and email
  shared INTEGER NOT NULL DEFAULT 0,         -- 1: everyone signed in sees it
  created_at INTEGER NOT NULL
);
CREATE INDEX saved_searches_page ON saved_searches (page, email);
