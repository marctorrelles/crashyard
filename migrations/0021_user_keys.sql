-- An event's user, searchable: a hash of each field the SDK sent (id, email lowercased, username, name), space-separated
-- (src/search/user.ts); null for the events there were, which `user:` still finds by `user_hash`
ALTER TABLE events ADD COLUMN user_keys TEXT;
