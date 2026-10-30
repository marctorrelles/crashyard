# 2. D1 for everything searchable, R2 for files

**Context.** crashyard runs on a single Cloudflare Worker, so it uses Cloudflare's storage. The options are D1, which is
SQLite, R2 for objects, Durable Objects, KV and Analytics Engine.

**Decision.** Issues, events, tags, logs and monitors live in D1, searched with SQLite's FTS5 and indexed tag tables.
Raw envelopes, attachments, debug files and source maps live in R2. There's no ORM. Queries are SQL with prepared
statements, and migrations are numbered files in `migrations/`.

**What it costs.** A D1 database holds up to 10 GB on Workers Paid and 500 MB on Free, and the free plan allows 100,000
row writes a day. Retention and per-project limits are therefore part of the design, not extras. A single database also
handles writes one at a time. Beyond a few hundred events a second, ingest would need a queue in front of it.
