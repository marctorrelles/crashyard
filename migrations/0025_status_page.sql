-- A project's public status page (/status/<project>): the uptime checks shown on it, by choice
ALTER TABLE monitors ADD COLUMN public INTEGER NOT NULL DEFAULT 0; -- 1: on its project's status page; uptime checks only
