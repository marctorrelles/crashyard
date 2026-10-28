-- A person's devices with push notifications on (Settings, Preferences), by email as preferences are, so a dev
-- server's dev@localhost has them too. Their push channel (`channels.kind` 'push', config {"email"}) sends to them
CREATE TABLE push_devices (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,             -- the push service's address for this browser
  p256dh TEXT NOT NULL,                      -- the browser's public key, base64url
  auth TEXT NOT NULL,                        -- its auth secret, base64url
  name TEXT NOT NULL,                        -- "iPhone, Safari", from the user agent
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER
);
CREATE INDEX push_devices_email ON push_devices (email);

-- Someone removed takes their devices and their push channel with them
CREATE TRIGGER users_push_delete AFTER DELETE ON users BEGIN
  DELETE FROM push_devices WHERE email = old.email;
  DELETE FROM channels WHERE kind = 'push' AND json_extract(config, '$.email') = old.email;
END;
