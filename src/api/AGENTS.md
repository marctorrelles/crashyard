# API

What the worker answers itself, ahead of Start. Under `/api/`, outside sign-in, each checks its own key or
signature; `/mcp` comes after sign-in.

- `ingest.ts`: `/api/<project>/envelope/` and `/api/<project>/store/`, what the Sentry SDKs send to, and the two that
  come without an SDK, checked against Relay's `endpoints/monitor.rs` and `endpoints/security_report.rs` (master,
  2026-10-27): `/api/<project>/security/` (POST only; `application/json`, `application/csp-report` or
  `application/reports+json`, else 415; empty is 400; the key from `?sentry_key=`; `sentry_release` and
  `sentry_environment` from the query, the `User-Agent` into the item header; answers 200 with no body) and
  `/api/<project>/cron/<slug>/<key>/` (GET or POST, the key optional when another way carries it; JSON POSTs are a
  check-in as the SDKs send it, `monitor_config` and all, else the query's `status`, `check_in_id`, `environment` and
  `duration`; no status of in_progress, ok or error is 400; answers 202 with no body). `fromDoor` makes each one
  envelope item, `raw_security` (Relay's name) or `check_in`, and `toEnvelope` the body held in R2, so from the key
  check on both take the envelope's path: quotas (a security report is an error, Relay's `security` category; a
  check-in has none), the held copy and retries. `src/server.ts`'s `INGEST` matches all four. A `raw_security` item
  is `cspReports` (`src/ingest/security.ts`), each an event through `eventOf`, the same steps as an `event` item, its
  id `stableEventId` of the held key and `index * 256 + j`. A check-in without an id gets its id chosen once, as events
  do: the run in progress it finishes, else `stableEventId` of the held key and its index; a retry, at the same
  received time, finds that row again (`recordCheckIn`), so it updates it instead of writing a second. A slug with a
  malformed `%` is 400 with a sentence. In order: CORS
  (`*`, the browser SDK sends from any origin), body, envelope, key, project and key from `project_keys` (cached a
  minute per isolate, by project id and key; `projects.public_key` isn't read), a key that's off answers 403 with
  Relay's `event submission rejected with_reason: ProjectId` (from Relay's source, not seen live), the project's
  allowed domains (`originAllowed`: the request's `Origin`, else `Referer`, as Relay's `is_valid_origin`; one not
  allowed answers 403 `event submission rejected with_reason: Cors`, Relay's, and its event and transaction items add
  to `project_days.filtered`; decided at the request, so a retry never needs the headers), the daily
  quotas, events, logs and transactions apart (`X-Sentry-Rate-Limits` by category, `error;…`, `log_item` or `transaction;span`, so SDKs stop sending
  that kind until tomorrow; 429 with `Retry-After` when nothing in the envelope can be kept), and the key's own daily
  limit on events (`<retry>:error;…:key:key_quota`, Sentry's scope and reason for a key's limit; counted in `key_days`
  per event item let in less those a filter dropped, at the request after its pass, so a retry never counts it again
  and filtered events count towards neither limit), then the envelope is held in R2 (`pending/`, `src/ingest/retry.ts`) and each item is processed in its own `try`
  (`processItems`, which the cron's `retryEnvelope` calls too): an `EnvelopeError` answers 400 and drops the held copy;
  any other error lists the item (`3`, or `3:2` for a span item from its third segment, so a retry doesn't count the
  first two again) and the rest goes on; the answer is 200 either way, as Relay's. Anything else the pass throws, once
  the envelope is held, is logged and still answers 200 (202 for a check-in), leaving the copy for the cron; only an
  envelope that couldn't be held answers 500. An envelope of sessions alone isn't held (docs/decisions/0004). The items:
  `event`, `attachment`, `feedback`, `user_report`, `log`, `check_in` and `session`/`sessions` (no quota: few, and
  they say something's alive), `transaction` and `span` (streamed spans, `span.v2`: what @sentry/node 11 sends instead
  of transactions, checked against 11.9.0, and sentry-dart 10 by default; see `src/performance/`); other item types are accepted and dropped. An event without an id gets one from the held key and its index
  (`stableEventId`), the same on every try. An event goes through the project's inbound filters (`filterReason`,
  right after `normalizeEvent`, before symbols, as Relay filters what the SDK sent), then symbols, grouping rules
  (`applyRules`) and `groupingOf`, then `discarded_fingerprints` (one read by key); a transaction or span segment
  through `transactionFilterReason`. What they drop isn't stored, and the pass adds it to `project_days.filtered`
  once, at its end (`countFiltered`, best-effort: a failure is logged, never a failed envelope); `project_days.events` counts only stored events, so the quota never sees them. A
  worker stopped mid-pass may count a filtered event twice, as logs. A retry reads the project by id alone (a key turned off since doesn't lose
  what was accepted) and skips the quota (what's held was let in). The raw envelope goes
  to R2 (`envelopes/<project>/<day>/<event>`). An attachment (1 MB at most) goes to
  `attachments/<project>/<event>/<item index>-<filename>`, its row inserted `ON CONFLICT (event_id, r2_key) DO NOTHING`
  (0019's unique index), so two files of one name both stay and a whole-envelope retry writes no second row. Notices are dispatched after the response (`ctx.waitUntil`). A crash
  tagged `distribution: app_review` or `testflight` also sends `review_crash`, once per issue. Each event reads the
  routes with a `frequency` for its project, and a `frequency` notice goes for each whose limit it reached
  (`src/notify/rules.ts`); notices carry the event's tags for routes' tag filters.
- `sentry.ts`: `/api/0/`, what sentry-cli and the build plugins call, with an auth token (`tokens`, for every project
  or one, `project_id`: one project's token gets Sentry's 403, `You do not have permission to perform this action.`,
  on `files/difs/assemble`, `artifactbundle/assemble` and a release that name another project, and its set-commits
  reach only its own project; chunks are the organisation's, so any token uploads them): chunk-upload (options,
  then gzipped chunks), `files/difs/assemble` (debug files, ProGuard), `artifactbundle/assemble` (source maps), and
  releases (kept with their commit). Assembling happens in the request, so the answer is `ok` at once. The
  organisation in the path is ignored. A project, in a path or a body's `projects`, is its slug or, as Sentry takes
  either, its number (`projectId`: a slug of digits wins over another project's number). Commits: `repos/` answers none, so `releases set-commits` (sentry-cli 3.8,
  `--local` or not) reads the local git and PUTs the release with `commits` (id, message, author, time and each one's
  files, `patch_set`, A/M/D), newest first, which go to every project with that release (`src/data/source.ts`);
  before that it asks `previous-with-commits/` (the newest earlier release of those projects with commits, its head
  as `lastCommit`, only the token's project for a project's token, as releases; 404 when none, so the first sends `--initial-depth` commits, 20 by default) and sends only the
  commits since. `releases/<version>/deploys/`: `deploys new` (sentry-cli 3.8 POSTs `environment`, `name`, `url`,
  `dateStarted`, `dateFinished`, `-t` as both, and `projects` when `-p` is given; a `url` only when it's http or
  https, else none) stores one row per project
  (`storeDeploy`): those named, checked by `allowed` as other uploads, else every project with the release (in
  `releases`, events or sessions), a project's token only its own; answered in Sentry's Deploy shape (`id`,
  `environment`, `name`, `url`, `dateStarted`, `dateFinished`), 201. `deploys list` (GET) lists them.
  `sentry.test.ts` calls it on `test/fakes.ts`: a project by slug or number, deploy links, and a project's token refused on another project for
  artifact bundles, releases POST and PUT, set-commits, deploys and previous-with-commits.
- `telegram.ts`: `POST /api/telegram/<bot id>`, a bot's webhook (set by saving a Telegram channel,
  `src/notify/AGENTS.md`). Let in only with `X-Telegram-Bot-Api-Secret-Token` equal to a secret of that bot's
  channels (compared as SHA-256 digests), else 403; then always 200, or Telegram sends the update again. A
  `callback_query` from a channel's own chat acts on the issue as the channel's `owner` (else "@name on Telegram"):
  `r` resolves, `i` ignores until it escalates, `a` assigns to the owner, through `changeIssues` and `assignIssue`,
  so the activity names who; `answerCallbackQuery` with a toast ("Resolved", "That issue no longer exists"), and
  `editMessageReplyMarkup` turns the button into "✓ Resolved" (resolving or ignoring takes the whole row; assigning
  only its button). `telegram.test.ts` on `test/fakes.ts` with `fetch` stubbed.
- `mcp.ts`: `/mcp`, the MCP server (JSON-RPC over POST, answered as JSON): tools over `src/data/`. It's behind
  sign-in (routed after it in `src/server.ts`, as the dashboard), `handleMcp(request, db, { email, role })`; JSON only
  and never cross-site, so a web page can't call it with someone's cookie. An agent sends
  `Authorization: Bearer cyp_…` (Settings, Agent tokens; `userTokenOf`), acting as its person with
  `tokenRole`: a read token is a viewer, a change token at most a member. The tools marked `changes`
  (`resolve_issue`, `ignore_issue`, `add_note`) answer an `isError` result for a role below member, saying so
  (`mcp.test.ts`). See docs/mcp.md. `get_issue` ends with the issue's suspect commits (`suspectCommits`), when there are any.
