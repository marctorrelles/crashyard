-- crashyard's own sign-in (src/auth/AGENTS.md): people with a role, their passkeys and sessions, invites, recovery
-- codes and their tokens for agents. Every secret is kept only as its SHA-256. Unread while AUTH is `access`, but
-- for the passkey made there to move over.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,                 -- lowercased
  name TEXT NOT NULL,
  role TEXT NOT NULL,                         -- owner, admin, member or viewer
  github_id INTEGER UNIQUE,                   -- set on their first sign-in with GitHub
  created_at INTEGER NOT NULL,
  created_by TEXT,                            -- the inviter's email; null for the first owner
  last_seen_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                        -- the credential id, base64url
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                            -- JSON list
  name TEXT NOT NULL,                         -- "iPhone", from the browser that made it; renamable
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,                      -- SHA-256 of the cookie's value
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- A passkey ceremony's challenge, one use, five minutes
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL,                      -- setup, signin, register or invite
  data TEXT NOT NULL,                         -- JSON: who it's for
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE invites (
  hash TEXT PRIMARY KEY,                      -- SHA-256 of the link's token
  role TEXT NOT NULL,
  email TEXT,                                 -- when the inviter named one
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by INTEGER REFERENCES users (id) ON DELETE SET NULL
) WITHOUT ROWID;

CREATE TABLE recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  used_at INTEGER,
  PRIMARY KEY (user_id, hash)
) WITHOUT ROWID;

-- A person's tokens for agents (MCP), `cyp_…`, acting for them up to their scope
CREATE TABLE user_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,                        -- read or change
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER                          -- null: never
);
CREATE INDEX user_tokens_user ON user_tokens (user_id);
