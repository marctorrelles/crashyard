-- What sentry-cli and the build plugins upload, Sentry's way: chunks (in R2, by SHA-1) assemble into files.
-- Debug files (dSYMs, ELF, ProGuard mappings) are kept per object, with the SymCache made from each; source maps come
-- in artifact bundles, found by the debug id their files carry.
CREATE TABLE debug_files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,                    -- SHA-1 of the uploaded file
  name TEXT NOT NULL,                        -- as sentry-cli names it
  debug_id TEXT NOT NULL,                    -- lowercase, as symbolic writes it (a ProGuard mapping's UUID too)
  code_id TEXT,
  arch TEXT,
  kind TEXT NOT NULL,                        -- macho, elf, pe, wasm, breakpad, proguard
  file_key TEXT NOT NULL,                    -- the file in R2
  symcache_key TEXT,                         -- its SymCache in R2 (not for ProGuard)
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, debug_id, checksum)
);
CREATE INDEX debug_files_lookup ON debug_files (project_id, debug_id, created_at DESC);

CREATE TABLE artifact_bundles (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  release TEXT,
  dist TEXT,
  file_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, checksum)
);

-- Each minified file in a bundle and its source map: the SourceMapCache made from the pair, found by the debug id
-- they share, or by the URL the app serves the minified file at
CREATE TABLE artifact_files (
  bundle_id INTEGER NOT NULL REFERENCES artifact_bundles (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL,
  debug_id TEXT NOT NULL,
  type TEXT NOT NULL,                        -- minified_source, source_map
  path TEXT NOT NULL,                        -- inside the bundle's zip
  url TEXT,                                  -- as the app serves it (~/assets/app.js)
  cache_key TEXT,                            -- minified_source: its SourceMapCache in R2
  PRIMARY KEY (bundle_id, path)
) WITHOUT ROWID;
CREATE INDEX artifact_files_debug_id ON artifact_files (project_id, debug_id, type);
CREATE INDEX artifact_files_url ON artifact_files (project_id, url, type);

-- Releases as sentry-cli and the plugins create them, with the commit when they name one
CREATE TABLE releases (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (project_id, version)
) WITHOUT ROWID;
