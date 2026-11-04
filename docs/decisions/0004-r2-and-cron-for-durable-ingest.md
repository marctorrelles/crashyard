# 4. R2 and the minute cron for durable ingest

**Context.** Sentry's SDKs send an envelope once. If crashyard fails while it stores it, because D1 is briefly
unavailable, R2 can't be read for symbolication or the worker runs out of time, the crash is gone. Cloudflare Queues
would retry it, but they need the Workers Paid plan, and crashyard should run on the free one.

**Decision.** Before an envelope is processed, the worker puts it in R2 under `pending/`. Each item is processed on its
own. When every item is stored, the copy is deleted. When one fails, the copy stays with the list of items that failed,
and the answer is still a 200 with the event ID, as Sentry's Relay accepts an envelope before it processes it. The
cron that already runs every minute tries the copies older than two minutes again, only their failed items, up to 25
a minute, last among its jobs and with the time they left. Each try is counted before it starts, so an envelope that
stops the worker every time still ends after five tries. It then moves to `failed/` and counts as failed on its
project's day. Events are stored once by their event ID, so trying one again never makes a second copy.

An envelope of sessions alone isn't held. Sessions are small, frequent and counted as they come, and losing one now
and then costs less than a write for each.

**What it costs.** R2's class A operations, its writes and lists. An event envelope costs 1 write, the held copy (a
raw copy under `envelopes/` was dropped: unscrubbed and never read). The minute cron's list costs about 43,000 a
month. So the free 1 million class A operations a month hold about 31,000 event envelopes a day. An item that fails waits two minutes or more before it's
tried again. A worker stopped halfway through an envelope, for running out of time, has its whole envelope tried
again. Its events are stored once, but the logs, transactions and filtered events it had already counted are counted
again.
