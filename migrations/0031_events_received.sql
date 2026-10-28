-- Explore over every project reads a window of events by when they came: without this it scanned them all
CREATE INDEX events_received ON events (received DESC);
