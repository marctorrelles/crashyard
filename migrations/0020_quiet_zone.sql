-- The IANA time zone a channel's quiet hours are in, so daylight saving doesn't move them; null for the rows there
-- were, whose quiet hours stay in UTC
ALTER TABLE channels ADD COLUMN quiet_zone TEXT;
