-- Finding an analytics user by any field the app set (id, email, username), not only by what their hash is of: one row
-- a project and field hash (src/search/user.ts, as events.user_keys), naming the user_hash their actions carry.
-- `seen` moves at most once a day, so a user's actions don't rewrite it; pruned with the actions' retention.
CREATE TABLE action_users (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  seen INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
) WITHOUT ROWID;
