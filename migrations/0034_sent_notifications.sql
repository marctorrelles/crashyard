-- Each notice a route sent, for Notifications' list: what it said and what each of its channels did with it
CREATE TABLE sent_notifications (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL,                     -- the Notice, as JSON
  deliveries TEXT NOT NULL                   -- {"<channel id>": {"state": "sent" | "held" | "failed", "error"?}}
);
CREATE INDEX sent_notifications_at ON sent_notifications (at);

-- A held notice's row in sent_notifications, set to sent or failed once quiet hours end (null: held before 0034)
ALTER TABLE held_notifications ADD COLUMN sent_id INTEGER;
