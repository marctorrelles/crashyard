-- What each project's day lost: envelopes that failed every retry (src/ingest/retry.ts), and events an inbound filter
-- dropped (filled from phase 5 on)
ALTER TABLE project_days ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_days ADD COLUMN filtered INTEGER NOT NULL DEFAULT 0;

-- Attachments are pruned by when they came, with their project's event retention; those already stored take their
-- event's time, and one whose event is gone takes 0, so the next prune removes it
ALTER TABLE attachments ADD COLUMN received INTEGER NOT NULL DEFAULT 0; -- ms
UPDATE attachments SET received = COALESCE((SELECT e.received FROM events e WHERE e.id = attachments.event_id), 0);
CREATE INDEX attachments_received ON attachments (received);
