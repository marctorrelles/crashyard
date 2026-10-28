-- Forward to Sentry (src/ingest/forward.ts): every envelope the project accepts goes on to this Sentry DSN too
ALTER TABLE projects ADD COLUMN forward_dsn TEXT; -- a Sentry DSN; null for none
