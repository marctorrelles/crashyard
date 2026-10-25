# Search

Sentry's search syntax for issues, as SQL (`query.ts`, pure, tested in `query.test.ts`).

- Tokens: `key:value`, `!key:value`, `key:>value` (also `<`, `>=`, `<=`), `"quoted text"`, words. `withToken` rewrites
  one key (the status tabs edit `is:` in the query, so the query stays the one truth).
- Keys: `is:` (`unresolved`, `resolved`, `ignored`, `new`, `regressed`, `ongoing`), `level`, `type`, `platform`,
  `firstRelease`, `lastRelease`, `project`, `has:`, `times`/`events`, `users`, `lastSeen`/`firstSeen` (`-24h` within,
  `+24h` longer ago, or a date). Any other key is a tag: "had an event with it", from `issue_tag_values`. `*` matches
  with GLOB (case-sensitive, as Sentry's).
- Words are prefixes, all of them, in the title or culprit (FTS5 `issues_fts`).
- An issue reads as new for `NEW_FOR` (a week) after its first event, as Sentry's.
