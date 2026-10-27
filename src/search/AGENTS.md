# Search

Sentry's search syntax for issues, as SQL (`query.ts`, pure, tested in `query.test.ts`), and what the search bar
proposes as you type (`suggest.ts`, pure, tested in `suggest.test.ts`). `filterExample(key)` is `key:value` with
a value that fits the key (`monitor:nightly-export`, `release:1.0`), for the examples in widgets' and metric alerts'
filter errors.

- Tokens: `key:value`, `!key:value`, `key:>value` (also `<`, `>=`, `<=`), `key:[a,"b c"]` (any of; `!key:[…]` none of),
  `"quoted text"`, words. A list's token has `values` (and `value`, them joined by commas); a list needs a key, a bare
  `[a,b]` is a word; a list's items lose the spaces around them, not those in their quotes. `unparse` writes tokens back
  so they read the same: values with a space, a quote, a backslash, `,` `[` `]` `:`, or starting `!` `<` `>` `=` are
  quoted (a seeded property test checks thousands of random token lists read back as written). `scan` gives every token
  with its place in the text (for the caret).
- The query stays the one truth; helpers rewrite it: `withToken` one key (the status tabs edit `is:`), `setToken` and
  `removeToken` one token by index (a pill), `addValue` includes or excludes a value (a facet): including adds it to the
  key's `key:[…]` (or adds `key:value`), excluding to `!key:[…]`, and either takes it out of the other; a list of one
  reads `key:value` again, of none goes. Only keys the grammar can write (`isSearchableKey`: `[\w.-]+`) take a value;
  any other key (`song name`, `sentry:user`) leaves the query as it is, and pages offer no + or − for it.
  `logAttributeKey`: the key a log attribute is searched by: `sentry.release` and `sentry.environment` by their columns,
  none for the other `sentry.*` (ingest doesn't store them as attributes) or the reserved names (`level`, `release`, …).
- `ISSUE_KEYS` and `LOG_KEYS`: the built-in keys for the bar, each with a description, a kind (`enum`, `text`,
  `number`, `time`, `tag`) and, for enums and times, its values.
- Lists in SQL: `col IN (?,…)` (for a tag, `v.value IN`), or an `OR` of matches when one has a `*`; `is:[…]` is an `OR`
  of the statuses, `project:[…]` adds every slug, `has:[…]` any of the keys, `message:[…]` any of the phrases (FTS5
  `OR`); numbers and times ignore a list. Every value is a `?` bind.
- Keys: `is:` (`unresolved`, `resolved`, `ignored`, `new`, `regressed`, `escalating`, `ongoing`, `assigned`,
  `unassigned`, and the viewer's own `bookmarked` and `unread`: `issueFilter`'s third argument, the viewer's email;
  without one, as in widgets and alerts, nothing is bookmarked and everything is unread; `UNREAD`, an issue with no
  `issue_views` row of the viewer's at or after its `last_seen`), `assigned:me` (the viewer, nobody without one) or
  `assigned:<email>` (globs as other columns), `level`,
  `priority` (`high`, `medium`, `low`), `type`, `platform`,
  `firstRelease`, `lastRelease`, `project`, `has:`, `times`/`events`, `users`, `lastSeen`/`firstSeen` (`-24h` within,
  `+24h` longer ago, or a date). Any other key is a tag: "had an event with it", from `issue_tag_values`. `*` matches
  with GLOB (case-sensitive, as Sentry's).
- `matchAny` is exported for other SQL over columns (metric alert filters, `src/notify/metrics.ts`); the tokens are
  reused for routes' tag filters (`src/notify/rules.ts`), matched against one event in JS.
- Words are prefixes, all of them, in the title or culprit (FTS5 `issues_fts`).
- `trace:<id>` finds the issues with an event in that trace.
- `logFilter`: the same syntax over logs: `level` (`warning` reads as `warn`), `release`, `environment`, `trace`,
  `timestamp`, `has:`, free text in the body (FTS5 `logs_fts`); any other key is an attribute (`log_attributes`).
- `eventFilter`: the same syntax over events one by one (`events e`), for Explore and an issue's event search:
  `level`, `release`, `environment`, `platform`, `trace` (columns), `is:` (its issue's status: unresolved, resolved,
  ignored), `issue` (ids, whole numbers only), `project`, `timestamp` (`received`), `has:` and any other key a tag
  of the event's own (`event_tags`, not the issue's), words and quoted text as `instr(lower(e.message), lower(?))`
  (events have no full-text index; `message` is title and message). `EVENT_KEYS` are its keys for the bar
  (`SearchBar` scope `events`, whose stored keys and values are the issues' tags).
- An issue reads as new for `NEW_FOR` (a week) after its first event, as Sentry's.
- `suggest.ts`: `contextAt(query, caret)` says what the caret is in (a key or free word being typed, with `!`; or the
  value of a key, with its operator, inside a `[…]` list too; a quote not yet closed runs to the caret, spaces and all)
  and what's typed of it; `suggest` proposes keys (the catalogue's order: built-ins first, then the stored tags;
  starting with what's typed, then containing it, case-insensitive), a key's values (its enum or times, the tag keys for
  `has:`, else the values the server sent) and, before a value is typed, `!` and, for numbers and times, the
  comparisons; `apply` puts a pick in the text and says where the caret goes (a key leaves `key:`, a value quotes as
  needed and adds a space after, in a list it replaces the item being typed; typing in the key of a whole `key:value`
  changes only the key).
