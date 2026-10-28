-- Status pages of their own instead of one per project (src/data/status.ts): each shows the uptime checks of any
-- projects it picks, a check on as many pages as you like, with its own posts, look and domain. Each project's page
-- carries over under the project's slug and name, so its address and domain keep working.
CREATE TABLE status_pages (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE, -- /status/<slug>
  name TEXT NOT NULL,        -- the team's name for it, and the page's title unless branding has one
  branding TEXT,             -- JSON: title, description, logo, color, website; null for none
  domain TEXT UNIQUE,        -- a hostname that opens only this page
  created_at INTEGER NOT NULL
);

CREATE TABLE status_page_monitors (
  page_id INTEGER NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, monitor_id)
) WITHOUT ROWID;
CREATE INDEX status_page_monitors_monitor ON status_page_monitors (monitor_id);

INSERT INTO status_pages (slug, name, branding, domain, created_at)
SELECT p.slug, p.name, p.status_page, p.status_domain, p.created_at FROM projects p
WHERE p.status_page IS NOT NULL OR p.status_domain IS NOT NULL
   OR EXISTS (SELECT 1 FROM monitors m WHERE m.project_id = p.id AND m.public = 1 AND m.kind = 'uptime')
   OR EXISTS (SELECT 1 FROM status_posts s WHERE s.project_id = p.id);

INSERT INTO status_page_monitors (page_id, monitor_id)
SELECT s.id, m.id FROM monitors m JOIN projects p ON p.id = m.project_id JOIN status_pages s ON s.slug = p.slug
WHERE m.public = 1 AND m.kind = 'uptime';

-- Posts belong to a page now. The three tables are made again with the same ids, and the old ones dropped children
-- first, so dropping them cascades to nothing
CREATE TABLE status_posts_new (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  impact TEXT NOT NULL,      -- notice, minor, major or maintenance
  starts_at INTEGER,         -- maintenance only: its window
  ends_at INTEGER,
  resolved_at INTEGER,       -- null while open; maintenance also ends at ends_at
  created_at INTEGER NOT NULL
);
INSERT INTO status_posts_new (id, page_id, title, impact, starts_at, ends_at, resolved_at, created_at)
SELECT s.id, pg.id, s.title, s.impact, s.starts_at, s.ends_at, s.resolved_at, s.created_at
FROM status_posts s JOIN projects p ON p.id = s.project_id JOIN status_pages pg ON pg.slug = p.slug;

CREATE TABLE status_updates_new (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES status_posts_new (id) ON DELETE CASCADE,
  state TEXT NOT NULL,       -- investigating, identified, monitoring, update or resolved
  message TEXT NOT NULL,     -- the little markdown src/components/markdown.tsx reads
  by TEXT NOT NULL,          -- who posted it, never shown on the public page
  at INTEGER NOT NULL
);
INSERT INTO status_updates_new SELECT id, post_id, state, message, by, at FROM status_updates;

CREATE TABLE status_post_monitors_new (
  post_id INTEGER NOT NULL REFERENCES status_posts_new (id) ON DELETE CASCADE,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, monitor_id)
) WITHOUT ROWID;
INSERT INTO status_post_monitors_new SELECT post_id, monitor_id FROM status_post_monitors;

DROP TABLE status_post_monitors;
DROP TABLE status_updates;
DROP TABLE status_posts;
ALTER TABLE status_posts_new RENAME TO status_posts;
ALTER TABLE status_updates_new RENAME TO status_updates;
ALTER TABLE status_post_monitors_new RENAME TO status_post_monitors;
CREATE INDEX status_posts_page ON status_posts (page_id, created_at);
CREATE INDEX status_updates_post ON status_updates (post_id, at);

-- What the pages now hold
DROP INDEX projects_status_domain;
ALTER TABLE projects DROP COLUMN status_page;
ALTER TABLE projects DROP COLUMN status_domain;
ALTER TABLE monitors DROP COLUMN public;
