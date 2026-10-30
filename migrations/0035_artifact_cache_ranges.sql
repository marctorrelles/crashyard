-- A bundle's SourceMapCaches live in one R2 object; each file's is the range [cache_offset, +cache_length).
-- Null on older rows: their cache_key is the whole object.
ALTER TABLE artifact_files ADD COLUMN cache_offset INTEGER;
ALTER TABLE artifact_files ADD COLUMN cache_length INTEGER;
