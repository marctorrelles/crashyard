-- A crashed session counted once: the browser SDK sends a session again after it went `unhandled` (once the page is
-- idle, or when the user changes), and each of those updates counted another crash, past the sessions themselves
CREATE TABLE session_crashes (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  sid TEXT NOT NULL,                         -- the SDK's session id
  at INTEGER NOT NULL,                       -- ms, when it was first counted; pruned after two days
  PRIMARY KEY (project_id, sid)
) WITHOUT ROWID;
CREATE INDEX session_crashes_at ON session_crashes (at);

-- What was counted twice before can't be undone exactly: a day never has more crashed sessions than sessions
UPDATE sessions_daily SET crashed = started WHERE crashed > started;
