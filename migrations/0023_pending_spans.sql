-- Streamed spans (span v2) that came before their segment span, as from a segment longer than the SDK's batch
-- interval: held until the segment comes and reads them into its transaction, else pruned after a day.
CREATE TABLE pending_spans (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  span_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,                  -- the segment span's id, `sentry.segment.id`
  received INTEGER NOT NULL,
  span TEXT NOT NULL,                        -- JSON: the span as sent
  PRIMARY KEY (project_id, span_id)
) WITHOUT ROWID;
CREATE INDEX pending_spans_segment ON pending_spans (project_id, segment_id);
CREATE INDEX pending_spans_received ON pending_spans (received);
