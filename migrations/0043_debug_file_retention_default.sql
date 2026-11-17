-- Debug files and source maps unused for 7 days go by default, not 90, which kept three months of builds no crash
-- reads. A project still at 90, 0039's default, moves to 7, and so does a saved Defaults for new projects still at 90
-- (it holds every field once any is saved). Another number, set by someone, stays. The column's own DEFAULT stays 90,
-- as changing it means rebuilding projects: createProject always writes the value (PROJECT_DEFAULTS,
-- src/data/settings.ts).
UPDATE projects SET debug_file_retention_days = 7 WHERE debug_file_retention_days = 90;
-- CASE, so a value that isn't JSON is read as having none, not an error
UPDATE settings SET value = json_set(value, '$.debug_file_retention_days', 7)
  WHERE key = 'defaults.project'
  AND json_extract(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.debug_file_retention_days') = 90;
