-- One row per attachment of an event: a whole-envelope retry wrote a second row for the same R2 object. The copies
-- go first, keeping the oldest row (each pointed at the same object), so the unique index can be made
DELETE FROM attachments WHERE id NOT IN (SELECT MIN(id) FROM attachments GROUP BY event_id, r2_key);
CREATE UNIQUE INDEX attachments_event_key ON attachments (event_id, r2_key);
