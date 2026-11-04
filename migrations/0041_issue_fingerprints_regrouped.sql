-- 1 when the fingerprint is the issue's own under another grouping version or once its stack became readable, not
-- another issue merged into it: issue pages don't count or list it as a merge, and it can't be unmerged
ALTER TABLE issue_fingerprints ADD COLUMN regrouped INTEGER NOT NULL DEFAULT 0;
