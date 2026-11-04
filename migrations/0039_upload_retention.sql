-- Debug files and artifact bundles no longer kept forever: the hourly cron deletes one uploaded and last used more than
-- the project's `debug_file_retention_days` ago, unless it's the newest of its kind (src/data/projects.ts, pruneUploads).
ALTER TABLE projects ADD COLUMN debug_file_retention_days INTEGER NOT NULL DEFAULT 90;
-- When symbolication last read it, moved once a day at most; null: never since 0039
ALTER TABLE debug_files ADD COLUMN last_used_at INTEGER;
-- When a source map lookup last read one of its files, as debug_files.last_used_at
ALTER TABLE artifact_bundles ADD COLUMN last_used_at INTEGER;
