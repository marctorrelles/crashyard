# 2. D1 for everything searchable, R2 for files

**Context.** crashyard runs on one Cloudflare Worker, so its storage is Cloudflare's: D1 (SQLite), R2 (objects),
Durable Objects, KV, Analytics Engine.

**Decision.** Issues, events, tags, logs and monitors live in D1, searched with SQLite's FTS5 and indexed tag tables.
Raw envelopes, attachments, debug files and source maps live in R2. No ORM: SQL with prepared statements, migrations
numbered in `migrations/`.

**What it costs.** One D1 database holds up to 10 GB, and the free plan writes 100,000 rows a day, so retention and
per-project quotas are part of the design, not extras. A single database also serialises writes; past a few hundred
events a second, ingest would need a queue in front.
