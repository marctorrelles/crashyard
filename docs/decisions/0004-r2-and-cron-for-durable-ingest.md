# 4. R2 and the minute cron for durable ingest

**Context.** Sentry's SDKs send an envelope once. If crashyard fails while it stores it, because D1 is briefly
unavailable, R2 can't be read for symbolication or the worker runs out of time, the crash is gone. Cloudflare Queues
would retry it, but they need the Workers Paid plan, and crashyard should run on the free one.

**Decision.** Before an envelope is processed, the worker puts it in R2 under `pending/`. Each item is processed on its
own. When every item is stored, the copy is deleted. When one fails, the copy stays with the list of items that failed,
and the answer is still a 200 with the event ID, as Sentry's Relay accepts an envelope before it processes it. The
cron that already runs every minute tries the copies older than two minutes again, only their failed items, up to 50
a minute. After five tries an envelope moves to `failed/` and counts as failed on its project's day. Events are stored
once by their event ID, so trying one again never makes a second copy.

**What it costs.** One more R2 write for every envelope, and a delete once it's stored. An item that fails waits two
minutes or more before it's tried again. A worker stopped halfway through an envelope, for running out of time, has its
whole envelope tried again: its events are stored once, but logs and transactions it had already counted are counted
again.
