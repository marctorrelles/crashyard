-- Debug files and artifact bundles no longer kept forever: the hourly cron deletes one uploaded and last used more than
-- the project's `debug_file_retention_days` ago, unless its build is still current (src/data/projects.ts, pruneUploads).
ALTER TABLE projects ADD COLUMN debug_file_retention_days INTEGER NOT NULL DEFAULT 90;
-- When symbolication last read it, moved once a day at most; null: never since 0039
ALTER TABLE debug_files ADD COLUMN last_used_at INTEGER;
-- When a source map lookup last read one of its files, as debug_files.last_used_at
ALTER TABLE artifact_bundles ADD COLUMN last_used_at INTEGER;
-- What's already uploaded counts as used now: lookups noted nothing before, so an older build still crashing gets a
-- whole retention to be seen instead of going at the first prune
UPDATE debug_files SET last_used_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
UPDATE artifact_bundles SET last_used_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
