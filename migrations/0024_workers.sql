-- Cloudflare Workers whose failed runs come in through crashyard's tail() handler (src/api/tail.ts), each producer
-- sending to it with `tail_consumers`
ALTER TABLE projects ADD COLUMN workers TEXT;                                -- JSON: the Workers' script names; null for none
ALTER TABLE projects ADD COLUMN worker_exceptions INTEGER NOT NULL DEFAULT 0; -- 1: uncaught exceptions too, for Workers without the SDK
