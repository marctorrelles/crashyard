-- The highest issue id ever given, so from here on a merged or deleted issue's id isn't given to a new one: links in
-- notifications keep opening the issue they named. AUTOINCREMENT would mean rebuilding issues, and dropping the old
-- table cascades to every table that references it. Filled from what's left of ids given before: the issues there are,
-- the ids merges recorded and the issues notices named (ISSUE_KINDS, as the others carry a monitor's or alert's id).
CREATE TABLE issue_ids (last INTEGER NOT NULL);
INSERT INTO issue_ids (last) SELECT MAX(
  COALESCE((SELECT MAX(id) FROM issues), 0),
  COALESCE((SELECT MAX(CAST(json_extract(j.value, '$.id') AS INTEGER)) FROM issue_activity a, json_each(a.data, '$.issues') j
    WHERE a.kind = 'merged'), 0),
  COALESCE((SELECT MAX(CAST(json_extract(payload, '$.issue.id') AS INTEGER)) FROM sent_notifications
    WHERE json_extract(payload, '$.kind') IN ('new', 'threshold', 'regression', 'ignore_expired', 'review_crash',
      'frequency', 'escalating')), 0)
);
CREATE TRIGGER issue_ids_last AFTER INSERT ON issues WHEN new.id > (SELECT last FROM issue_ids) BEGIN
  UPDATE issue_ids SET last = new.id;
END;
