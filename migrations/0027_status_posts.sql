-- What a project's status page says besides its checks (src/data/status.ts): incidents, notices and maintenance,
-- each with its updates, newest shown first
CREATE TABLE status_posts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  impact TEXT NOT NULL,      -- notice, minor, major or maintenance
  starts_at INTEGER,         -- maintenance only: its window
  ends_at INTEGER,
  resolved_at INTEGER,       -- null while open; maintenance also ends at ends_at
  created_at INTEGER NOT NULL
);
CREATE INDEX status_posts_project ON status_posts (project_id, created_at);

CREATE TABLE status_updates (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES status_posts (id) ON DELETE CASCADE,
  state TEXT NOT NULL,       -- investigating, identified, monitoring, update or resolved
  message TEXT NOT NULL,     -- the little markdown src/components/markdown.tsx reads
  by TEXT NOT NULL,          -- who posted it, never shown on the public page
  at INTEGER NOT NULL
);
CREATE INDEX status_updates_post ON status_updates (post_id, at);
