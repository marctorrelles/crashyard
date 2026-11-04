# 6. Small envelopes held in D1

Refines [0004](0004-r2-and-cron-for-durable-ingest.md).

**Context.** Holding every envelope in R2 while it's processed cost one R2 class A write for each, on top of the copy
under `envelopes/`. Workers Paid includes a million class A operations a month and charges $4.50 for each started
million after that, so any crashyard with real traffic paid for the hold alone. D1 includes 50 million rows written
a month on Paid and 100,000 a day on Free.

**Decision.** An envelope whose body is UTF-8 text of 512 KB or less is held as a row of `held_envelopes` in D1, a
quarter of D1's 2 MB for a value. It's text, not a BLOB, because D1 carries a BLOB both ways as an array of numbers.
Bigger bodies and binary ones, those with minidumps or images, are still held in R2 under `pending/`, as is any
envelope D1 refuses. Both use the same key, so event ids made from it stay the same on every try. The minute cron
tries D1's rows first, then R2's, 25 in all, and an envelope that fails five times moves to R2's `failed/` from either.
Envelopes held in R2 by an earlier version are retried as before.

**What it costs.** Two rows written for each envelope held in D1, one to hold it and one to drop it, and two more for
each retry, one to claim it and one to record how it went. An envelope over 512 KB still costs an R2 write. The cron still lists `pending/` in R2 every minute,
about 43,000 class A operations a month. A long outage that fails every envelope now fills D1 rather than R2 until the
envelopes run out of tries.
