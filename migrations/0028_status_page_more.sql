-- More for a project's status page (src/data/status.ts): what each post affects, the page's own look, its own domain
CREATE TABLE status_post_monitors (
  post_id INTEGER NOT NULL REFERENCES status_posts (id) ON DELETE CASCADE,
  monitor_id INTEGER NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, monitor_id)
) WITHOUT ROWID;

ALTER TABLE projects ADD COLUMN status_page TEXT;   -- JSON: title, description, logo, color, website; null for none
ALTER TABLE projects ADD COLUMN status_domain TEXT; -- a hostname that opens only this project's status page
CREATE UNIQUE INDEX projects_status_domain ON projects (status_domain) WHERE status_domain IS NOT NULL;
