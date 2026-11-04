# Ingest

What happens to an event between the SDK and D1. Pure functions, except `store.ts`. `src/api/ingest.ts` calls them in
order.

- `body.ts`: `readBody` reads the request, gunzipped or inflated, up to 20 MB (`BodyError` carries the status).
- `envelope.ts`: `parseEnvelope` splits a Sentry envelope (header line, then item header + payload, by `length` or up
  to the newline), at most 100 items (`MAX_ITEMS`) and header lines of 64 KB, else `EnvelopeError`: it runs before
  the key is checked, so a hostile body can't cost more memory than that. `payloadJson` parses an item.
- `auth.ts`: `projectKey` finds the DSN key: `X-Sentry-Auth` `sentry_key=`, `?sentry_key=`, `Authorization`, or the
  envelope header's `dsn`.
- `scrub.ts`: before anything is stored. Values under secret-looking keys become `[Filtered]`; emails, card numbers
  (14 to 19 digits that pass the Luhn check, so ms timestamps and ids stay) and bearer tokens in text are masked (an
  email's domain ends in letters, so a release like `app@1.2.0` stays; its patterns are bounded and anchored to the
  start of a run, one pass over any text: the unbounded email pattern took seconds on 100 KB without an `@`).
  The user is kept only as hashes (`src/search/user.ts`): `user_hash` (`hashUser` of the id, else email, else
  username) counts distinct users, and `user_keys` has one per field sent (id, email, username, name; never the IP
  address), which `user:` searches hash the same way. The deployment's own field names (Settings, Privacy, setting
  `privacy.scrub_fields`) are filtered too, in any key containing one, any case, as Sentry's additional sensitive
  fields: `loadExtraFields`, at the start of every pass (`processItems`), reads them at most once a minute per isolate,
  so a change takes up to a minute to apply; a read that fails is logged and keeps the last list (the built-ins only
  before the first), so it never fails an envelope.
- `event.ts`: `normalizeEvent` turns what any SDK sends into one shape (`NormalizedEvent`): title, culprit, level,
  frames (from the crashed thread when the exception has none), `threads` (every one of `threads.values`, 32 at most
  of 100 frames each, the innermost; crashed, then current, first; the thread an exception matches, by `thread_id` or
  `crashed`, keeps no frames, as its stack is the exception's; grouping reads only the exceptions; events stored
  before have none), tags (derived first, as only 30 are kept: level, release,
  os, device, browser, runtime, handled, mechanism, `monitor.slug` from `contexts.monitor.slug`; then the SDK's, pairs or
  object, the first 100 read), `message` (8 KB), `release` and `environment` (200 characters), `request` (method, URL, query string, headers as pairs, body as
  text of 8 KB at most; header and query keys that name a secret are filtered as in `scrub`, query values in the URL
  too, the rest masked as tags; headers that carry the client's IP, `x-forwarded-for`, `cf-connecting-ip`,
  `forwarded` and the like (`IP_HEADERS`, and any name matching `IP_HEADER`, such as `fly-client-ip`,
  `x-vercel-forwarded-for`, `x-appengine-user-ip` or `x-envoy-external-address`), are dropped and `request.env` with `REMOTE_ADDR` isn't kept, as crashyard
  stores no IPs), `extra` (scrubbed, keys in order while they fit in 16 KB of JSON) and `_trimmed`
  (what was cut: `request body`, `extra`). A `captureMessage` sends a made-up exception: `synthetic`, titled
  by its message, `type` `message`.
  For grouping v2 it also keeps a logged message's `template` (`logentry.message` when sent apart from `formatted`),
  an exception's `nsError` (`mechanism.meta.ns_error` domain and code), `exceptionId`, `parentId` and `isGroup` (the
  mechanism's, for exception groups) and a frame's own `platform`; a frame with `data.sourcemap` (mapped before it
  came, as Sentry's own events are) is `symbolicated`.
- `grouping.ts`: the fingerprint, by version (`HASHERS`, version → `(event, rules) => hash`, pure: neither changes
  the event). `GROUPING_VERSION` is 2.
  - Version 1 (`fingerprintOf`, `fingerprintV1`): crashyard's first, unchanged. Exception type + the top 5 in-app
    frames; a native frame without symbols is its image's basename + offset; an anonymous function (`?`,
    `<anonymous>`) is its context line, or file and line; a synthetic exception's type left out; no frames, the
    masked value (`mask`: numbers, hex, UUIDs, quoted text); a message its masked text. A custom `fingerprint` wins,
    `{{ default }}` expands to the default. Run on a copy from the SDK's in-app flags (`origInApp`) with the project's
    rules through `applyRules`, which reads them as it always has (below). `rules.test.ts` checks it against `grouping-v1.json`, every fixture's fingerprint
    taken before versions existed.
  - Version 2 (`fingerprintV2`, `componentsV2`): Sentry's grouping, `newstyle:2023-01-11` as getsentry/sentry
    24.10.0 has it (`src/sentry/grouping/strategies/newstyle.py`, `enhancer/`, `stacktraces/functions.py`,
    `lang/javascript/utils.py`, `strategies/message.py`, `parameterization.py`; Apache-2.0 since 2026-10-15 under
    its FSL-1.1-Apache-2.0 license, so nothing later is ported). Frames get Sentry's built-in rules then the project's
    (`statesOf`: `stackStates` of `BUILTIN_RULES` + the project's stack rules, cached per event, so hashing and
    `showInApp` read one). A frame is its module (Java's generated classes as `<auto>`, a JavaScript module made from
    an http/webpack/app URL as Sentry's `generate_modules`), else its filename's basename lower-cased (none for a URL
    origin, `<anonymous>`, `[native code]`), then its function trimmed (`trimFunction`; Ruby blocks and erb, PHP
    anonymous classes, Java lambdas, JavaScript's last segment and anonymous names left out, a source-mapped one where
    its line is known), then for javascript, node, python, php and ruby its context line of 120 characters or fewer;
    a JavaScript `eval` or native-code frame is nothing; recursion (equal to the frame before, function trimmed) and
    `-group` frames don't count. Per exception: the app variant's frames (in-app only), else the system variant's
    (all), else none; then its type (not a synthetic one), an NSError's domain and code, and its value
    (`parameterize`) when neither a stack nor an NSError counts. Every exception of the chain, after Sentry's
    exception-group filter (`groupedExceptions`: one distinct top-level exception and its first path, else each
    distinct one and the root). The app variant wins if any exception has app frames, else the system variant. No
    exception: the message's template (`template`, `Hello %s`) or text, parameterized. Fingerprint: a project's rule,
    else the SDK's when it isn't only `{{ default }}`, else Sentry's built-in fingerprints (`BUILTIN_FINGERPRINTS`),
    else the default. A frame's own `platform` wins over the event's (React Native). A browser script's filename
    loses its query string, as Sentry strips it.
  - Version 2's differences from Sentry, commented `crashyard:` where they're done: the 5 frames nearest the crash
    per exception, not all (`limit`); an in-app native frame without symbols is its image + offset (a system one is
    nothing, as Sentry); `mechanism: AppHang` is one type, "App Hang", its value never counted (macOS's "App Hanging",
    iOS's "App Hang Fully Blocked", "Non Fully Blocked", "Fatal …"); a JavaScript file or module not source-mapped
    loses a bundler's content hash (`withoutBundleHash`); an event without an exception groups by its text, not its
    threads; the built-in rules' crashyard section (`builtin-rules.ts`); security reports keep their own fingerprint;
    Django template frames, `max-frames=` and `min-frames=` aren't ported; a frame's `function` is read before its
    `raw_function` (C# would group by the raw one); emails are scrubbed before grouping. Bounds against what anyone
    with a DSN can send: only the innermost 250 frames of an exception (`GROUPING_FRAMES`, as Relay keeps 250) get
    rules and group, the rest keep the SDK's flags; `parameterize` reads 1,000 characters; `trimFunction` 4,000;
    the exception-group walk has no recursion and falls back to every exception if it throws, as Sentry's.
  - `grouping.test.ts`: every event of Sentry's grouping tests at 24.10.0 (`test/fixtures/sentry-grouping`) groups by
    the same values as Sentry (`componentsV2` with no frame limit), the differences listed in `DIFFERENT` as
    `it.fails`, so a fixed one shows; app hangs (`test/fixtures/hangs`); function names and modules; hostile events
    (30,000 frames, a 100 KB value, a 5,000-deep group, deep generics) staying fast. Cost: about 2 ms for a
    100-frame native stack on an M2, most of it the 460 rules over every frame.
  - Changing versions: a change that moves fingerprints adds the next version to `HASHERS` and bumps
    `GROUPING_VERSION`: `groupingOf` (store.ts, through `groupingFor`, with the project's rules, for ingest,
    `src/symbols/reprocess.ts` and the import alike) then, on a project's first event at it, records
    `grouping_previous` and `grouping_until` 30 days ahead (`GROUPING_OVERLAP`; the `UPDATE … WHERE grouping_version =`
    the old one, so racing isolates write it once, and the cached project row is updated in place), and until then
    computes the old hash too: when it differs and no issue has the new one, the issue holding the old (directly or
    through `issue_fingerprints`) gets the new in `issue_fingerprints` as `regrouped` (0041: not a merge, so not
    counted, listed or unmerged as one), and a discarded old hash discards the new too (`discarded_fingerprints`;
    `INSERT OR IGNORE`, one batch of two per event during the overlap). Past it, the old hash isn't computed. Then `showInApp` sets the frames' in-app flags on the
    event as the current version's rules leave them, the SDK's own kept in `origInApp`, and the culprit again.
    Events record `fingerprint` (before any merge) and `grouping_version`.
- `functions.ts`: `trimFunction` (Sentry's `trim_native_function_name` for native platforms: no arguments, return
  type, `const`, `[clone .…]`, generics as `<T>`, lambdas as `lambda`, MSVC anonymous namespaces, Rust hashes,
  `@GLIBC_`; Swift's `closure in X`, `thunk for closure`, `specialized`, `@objc` gone; Objective-C as it is),
  `behaviourOf` (native, javascript, other), `jsModule` (`generate_module`) and `withoutBundleHash`.
- `parameterize.ts`: Sentry 24.10.0's message parameterization for grouping v2: the first two non-empty lines (and
  `...` when cut), then email, url, hostname, ip, uuid, sha1, md5, date, duration, hex, float, int, and a quoted string
  or bool after `=`, each as `<kind>`, as one regular expression in Sentry's order. Not its unique-id experiment.
- `builtin-rules.ts`: `BUILTIN_RULES`, `sentry-rules.txt` (Sentry 24.10.0's `newstyle@2023-01-11.txt`, unchanged,
  read with Vite's `?raw`) then crashyard's: an app bundle's `main` and Swift `*.$main` are threadbase (Sentry gets
  there through `UIApplicationMain`, which crashyard can't name); an unnamed libsystem_pthread frame is `system`, not
  threadbase (Sentry's rule would hide every caller of a wait crashyard can't name); `function:Sentry*` (the SDK's
  Swift types) `-app -group`. `BUILTIN_FINGERPRINTS`: Sentry's `javascript@2024-02-02` (ChunkLoadError, React
  hydration errors per transaction). Parsed once per isolate; a bad line throws.
- `rules.ts`: grouping rules in Sentry's syntax, from its docs "Fingerprint Rules" and "Stack Trace Rules"
  (docs.sentry.io, read 2026-10-26) and Sentry 24.10.0's enhancer (`src/sentry/grouping/enhancer/`), a project's
  (its settings, Issues, `projects.grouping_rules`) and the built-in ones. `parseGroupingRules` answers
  `{ fingerprint, stack }` or `{ error, line }` (the first bad line and a sentence). Supported: matchers `error.type`
  (`type`), `error.value` (`value`), `message` (also every exception's value), `level`, `tags.<name>`
  (in version 2 `tags.transaction` falls back to the event's transaction, a tag in Sentry), and on a frame `stack.function`
  (`function`), `stack.module` (`module`), `stack.abs_path` (`path`, abs_path or filename), `stack.package`
  (`package`), `app` (yes, no), `family` (javascript, native, other, all; from the event's platform, `familyOf`, or
  in version 2 `behaviourOf` the frame's own) and `category`; `!` negates; quoted values (`\"` a quote; `\\` a
  backslash only with `{ escapes: true }`, the built-in rules, as Sentry reads its own: a project's keep it as written);
  `[ m ] |`
  matches the frame before (the caller), `| [ m ]` the one after (the callee), spaced or not, one frame matcher each,
  none past the ends; `#` after a space starts a comment, also after a rule's matchers and actions (after a
  fingerprint's arrow it stays a value, as before). Globs (`globToRegExp`): `*`, `?`, `[…]`, `[!…]`,
  `\`; paths `*` within a folder and `**` across, a leading `**/` matching a relative path; case-insensitive for
  error.value, message, level and paths, as the docs say. Fingerprint values split by commas or spaces, variables
  `{{ default }}`, `{{ error.type }}`, `{{ error.value }}`, `{{ message }}`, `{{ level }}`, `{{ transaction }}`,
  `{{ stack.function }}`, `{{ stack.module }}`, `{{ stack.abs_path }}`, `{{ stack.filename }}`, `{{ stack.package }}`
  (of the app's frame nearest the crash) and `{{ tags.<name> }}` (`''` when missing); a fingerprint rule's `family`
  is the event's in version 2, needing no frame; version 1 reads it on a frame. Stack actions `+app` `-app` `+group` `-group`, each with `^` (the frames above,
  nearer the crash) or `v` (below), and `category=<name>`. Not supported, refused with the line: `logger`,
  `max-frames=`, `min-frames=`, `title=`.
  - Version 1 (`applyRules`): stack rules in order over each exception's frames, each acting as it matches (no
    categories), setting `inApp` on the event and dropping `-group` frames from a copy; the culprit again; then the
    first fingerprint rule that matches.
  - Version 2 (`stackStates`, pure): Sentry's two passes over each stack, from the SDK's in-app flags
    (`origInApp ?? inApp`): first every rule's `+app`/`-app` and `category=`, rule by rule, each rule finding its
    frames before it acts; then, on the flags and categories left, `+group`/`-group`. Function matchers read the
    trimmed name (`trimFunction`, cached per frame), `<unknown>` for a frame without one; a path matcher reads the
    abs_path, else the filename, a relative one also with a leading slash, as Sentry's `path_like_match`. `setInApp` shows the states
    on the event (`origInApp` kept where they differ) and takes the culprit again; `fingerprintRule` the first
    matching fingerprint rule, filled in.
  - `rulesOf` parses a project's text once per isolate (100 kept); text that no longer parses applies as none, and
    `updateProject` refuses it with the line, so it can't be saved. The rules come with the project from ingest's
    cached read: a change applies within a minute, to new events only. `NO_RULES`: a project without any.
- `filters.ts`: inbound filters (a project's settings, Events, `projects.filters` JSON, `parseFilters` keeps only known switches
  and string lists). `filterReason(event, filters)` answers a Relay stat key or null: `browser-extensions` (the first
  exception's value against `EXTENSION_EXC_VALUES`, or the abs_path of its frame nearest the crash, skipping
  `<anonymous>` and `[native code]`, stopping at one without, against `EXTENSION_EXC_SOURCES`), `localhost` (the
  request URL's host is localhost or 127.0.0.1 or under them, a `file:` URL, a `Host` or `X-Forwarded-Host` header of
  either; only what Relay checks, so not `server_name`, which a phone app may call localhost; Relay's user IP check is
  left out as no IP is kept), `web-crawlers` (the event's `User-Agent` header, as Relay's `Event::user_agent`,
  against `WEB_CRAWLERS` and not `ALLOWED_WEB_CRAWLERS`), `legacy-browsers` (the same header; `browserOf`, a small
  parser naming families as uap-core does for these, so Mobile Safari, Chrome Mobile and Chrome on iOS aren't
  Safari or Chrome, as in Relay; below the cut-offs Sentry offers per browser today: IE all, Opera Mini 35, Opera
  100, Android 4, Safari 16, Edge, Chrome and Firefox 111; one switch for all), `react-hydration-errors` and
  `chunk-load-error` (Sentry's generic filters, the globs of `_hydration_error_filter` and `_chunk_load_error_filter`,
  over each exception's type and value), `error-message` (globs over the message and each exception as
  `Type: value`, as `error_messages.rs`) and `release-version`. `transactionFilterReason(name, release, filters)`:
  Sentry's `HEALTH_CHECK_GLOBS` and the release globs. Globs are Relay's patterns (`globToRegExp` with braces,
  case-insensitive). `originAllowed(origin, domains)`: `*`, a host, `*.host` (it and every subdomain), or
  `scheme://host:port`, as `matches_any_origin`; no origin, or no domains, is allowed. Read from Relay at
  `getsentry/relay` master 08526e6 (2026-10-23): `relay-filter/src/{browser_extensions,web_crawlers,legacy_browsers,
localhost,transaction_name,error_messages,releases,csp}.rs` and `relay-server/src/services/projects/project/info.rs`;
  from Sentry at `getsentry/sentry` master 7c3d287 (2026-10-26): `src/sentry/ingest/inbound_filters.py` and
  `HEALTH_CHECK_GLOBS` in `src/sentry/constants.py`. The plan named `filterReason(event, request, filters)`: the
  request's part, allowed domains, is `originAllowed` at the request instead, so retries agree with the request.
- `store.ts`: `storeEvent` writes an event: dedupes by event id, creates the issue (`ON CONFLICT DO NOTHING
RETURNING`), then one batch for the counts, days, tags, users and activity. `transitionOf` decides a reopening: a
  resolved issue regresses on any event, or, resolved in the next release, only on another release's, or, resolved
  in a release (`fixed_in_release`), on that release's or a newer one's but not an older one's nor one naming none
  (`olderThan`: one read, only for such an issue and another release, comparing `releases.created_at`, else the
  release's first event, else now for a release seen nowhere yet); an ignore ends by
  count or date. The batch's issue update writes the status only on a transition and only over the status it was decided from (a
  resolve or ignore made meanwhile stays), and counts the minute in SQL (`minute_count + 1`), so events at once
  don't undercount. Spike protection: past 60 events a minute an issue only counts, it stores no more events. Such an
  event has no `events` row to dedupe on, so if its item fails after the batch and is retried, it counts again in the
  issue, `project_days`, `event_hours` and `issue_minutes`: at most that minute's overflow, accepted rather than an
  idempotence key per counted event. A tag keeps
  100 values per issue (`TAG_VALUES`); a new one past them counts under `other` (reading at most the value's row or the
  first 100), so a search for such a value doesn't find the issue. An issue
  found with a count of 0 was made by a try whose batch then failed: the event is still its first (`isNew`, a "New
  issue" alert and the `created` activity); two first events racing may both say so. The batch also upserts
  `event_hours` and `issue_minutes` (every event, kept or not) and writes `events.user_hash`. A new issue's priority is the project's for
  its level (`priority.ts`: `priorityFor`, `projects.priorities`, else `PRIORITY_BY_LEVEL`); a project's `priorities`
  comes with it from ingest's cached read. An ignore `until_users` ends on an event from a user the issue hadn't had
  (one read of `issue_users`, only then) that takes `user_count` to `ignore_until_users`; `until_escalating` never ends
  here.
- `security.ts`: browsers' security reports (Relay's `security_report.rs` and `relay-event-normalization` CSP, read
  2026-10-27). `cspReports`: `{ "csp-report": … }` (report-uri, kebab-case: `effective-directive`, else the first word
  of `violated-directive`) or the Reporting API's list (report-to, camelCase `body`; only `csp-violation`, 100 at most,
  its `user_agent` kept), none without a directive. `blockedOf`: a URL's host, a bare word as itself (`inline`,
  `eval`, `data`, `self` for an empty one); `cspTitle` after Sentry's: "Blocked 'script' from 'host'", "Blocked unsafe
  inline 'style'", "Blocked unsafe eval() in 'script'" (the directive's kind without `-src`, `-elem`, `-attr`).
  `cspEvent`: a Sentry event of it (title as `logentry`, the directive as `culprit`, `fingerprint` `csp`, directive,
  blocked host, tags `csp.directive`, `csp.blocked`, `csp.disposition`, the page as `request.url`, the browser as its
  `User-Agent` so the inbound filters read it, the report as `csp`); `normalizeEvent` makes an event with a `csp`
  part type `csp`, its culprit the one given. Relay's CSP filter of disallowed sources isn't applied: browser
  extensions' own reports come through.
- `budget.ts`: `trimEvent` (`eventJson` in `storeEvent`, just before the JSON is written; the envelope stays whole in
  R2) keeps the stored JSON under 900 KB: only an event over it is copied and cut, each cut only while still over,
  least missed first: the newest 100 breadcrumbs, 32 threads of 100 frames (crashed first), an exception's innermost
  200 frames, texts over 4 KB anywhere, then whole parts (other threads, breadcrumb data, contexts, extra, request,
  breadcrumbs, all but 20 frames, threads). `_trimmed` names each, shown under the event.
- `retry.ts`: durable ingest (docs/decisions/0004 and 0006). `hold` takes the key
  `pending/<project>/<received ms>-<16 hex>` and holds the body under it: in D1, a `held_envelopes` row (0038), when
  it's UTF-8 text with no NUL of `HOLD_IN_D1_MAX` (512 KB, a quarter of D1's 2 MB value) or less, as TEXT (a fatal,
  BOM-keeping decode, so it comes back byte for byte; D1 carries a BLOB as an array of numbers); else, or when D1
  refuses (a project deleted meanwhile fails the foreign key), in R2 with `customMetadata`
  `{ endpoint, attempts, items?, leased_until? }`. Either way `attempts` is 1, the request's try counted as it starts,
  and `items` is set only when some were left out, by quota or as done; it answers `Held` with its `store`, `d1` or
  `r2`, or undefined when neither took it. The key seeds `stableEventId` the same in both. `release` drops the copy
  (an `EnvelopeError`). `settle` after a pass: nothing failed releases it, else the row is updated (or the R2 object
  rewritten) with what failed and the attempts so far, no lease, and the fifth moves the body to R2's
  `failed/<project>/<…>` from either store and adds 1 to `project_days.failed` (for a row, one batch: the count only
  while the row is there, then its delete, so two runs settling it count it once). `retryPending` (every minute, last
  of the cron's jobs, until its shared deadline), 25 retries in all: first D1's rows older than two minutes and not
  leased, oldest first (read from the primary key, `(received, key)`, so never the whole table; every statement on a
  row names both), each claimed by one `UPDATE … SET attempts = attempts + 1, leased_until … WHERE` not leased
  `RETURNING` the body, so an overlapping run claims none twice, one past five tries moving to `failed/` untried;
  then R2, as before 0038 and for envelopes held there
  by a worker from before it: pages through `pending/` (1000 keys a page, by `cursor`) so envelopes still in flight
  never hide older ones listed after them, skips one whose `leased_until` hasn't passed, and before each pass
  rewrites the copy with `attempts + 1` and `leased_until` the cron's `now` + 90 s. So a pass that stops the worker
  still counts, and a run overlapping the last one leaves it alone; one already at five tries moves to `failed/`
  untried. An envelope not reached before the deadline isn't counted. Each pass goes through `retryEnvelope`
  (`src/api/ingest.ts`; injectable for `retry.test.ts`, which runs each case on both stores with `test/fakes.ts`); a
  pass that throws counts as everything failing. A worker stopped mid-envelope leaves the state from before the
  pass, so every item in it is tried again: events dedupe by id, check-ins find their row again, logs, transactions
  and filtered events already counted count again.

- `import.ts`: Import from Sentry (Settings, a project's Sentry; `importFromSentry` in `fns.ts`, admin).
  `importPage`: one page of 10 (`PAGE`) on Workers Paid, 2 on Free or a plan not known yet (`cloudflare.plan`,
  `src/data/plan.ts`), of the Sentry project's issues, every status (`/api/0/projects/<org>/<project>/issues/?query=`,
  deprecated by Sentry for the organization's, which only lists a time window), then per issue not in `sentry_imports`
  (0026): `events/latest/` for its id, then `projects/<org>/<project>/events/<id>/json/` (`EventJsonEndpoint`,
  `event.as_dict()`, the stored event in the SDKs' shape, read in getsentry/sentry master 2026-10-27;
  `ApiPublishStatus.EXPERIMENTAL`, the JSON link of Sentry's event page), its comments only when `numComments`.
  Each issue costs 3 calls to Sentry and about ten D1 queries, so 10 a page only within Paid's limit. The event goes through `normalizeEvent`,
  `groupingFor` (the project's rules) and `storeEvent`, not symbolication (Sentry's frames are already symbolicated)
  and not filters or notices; then the issue takes Sentry's count (less the event just counted), first and last seen
  (min and max), users (max), resolved or ignored (`for_good`), unresolved as `ongoing`, and comments as notes by
  "<email> on Sentry". `nextCursor` reads the Link header. The browser asks for each page (`settings/projects/$slug/sentry.tsx`),
  so it can continue from where it stopped; the token comes with each call and is never stored. Sentry's errors as
  sentences: 401/403 the token's scopes, 404 the slugs, 429 wait. `import.test.ts`: fetch stubbed, GlitchTip fixtures;
  the SDK's next event of an imported error joins its issue.
- `forward.ts`: Forward to Sentry (a project's settings, Sentry; `projects.forward_dsn`, 0029, checked by
  `sentryTarget` in `fns.ts`, which keeps it tidied). `handleIngest`, once the key and the allowed domains pass and
  before quotas and filters, hands the body to `forwardToSentry` in `waitUntil` (a `store` event wrapped as an
  envelope; a security report or check-in as the envelope made at the door): POSTed once to `<base>/api/<id>/envelope/`
  with `X-Sentry-Auth`, the SDK's User-Agent and no client IP, the envelope header's `dsn`, when present, swapped for
  Sentry's (`retarget`); no retries, and the cron's retries never forward. Sentry's answer is only logged.
  `FORWARDED` marks the request, and a request carrying it isn't forwarded again, so a DSN pointing back at a crashyard
  can't loop. `forward_dsn` comes with the project from ingest's cached read, so a change takes up to a minute.
  Tail Workers' runs (`src/api/tail.ts`) aren't forwarded: Sentry wouldn't have had them, so their requests carry
  `FORWARDED`. The send times out after 10 seconds.
- `logs.ts`: Sentry's structured logs (a `log` item: `{ items: [...] }`, typed attributes), less the actions (`isAction`, written in the same batch by `storeLogs`'s `actions`). Keeps release,
  environment and trace id from the attributes; drops `user.*` (the SDK adds the scope's user, email included).
  `storeLogs` writes each log, then its own (not `sentry.*`) attributes, up to 16, into `log_attributes` with
  `last_insert_rowid()` (that table is WITHOUT ROWID, so the id stays the log's), and adds the batch to `log_hours`
  (an upsert for each hour and level in it) and `project_days`, in one batch. About 2 + attributes rows a log, plus one
  for each hour and level.
- `actions.ts`: product analytics through the SDK's logs. A log item whose `crashyard.action` attribute is true
  (`true`, `"true"` or 1; `isAction`) is an action, not a log: `normalizeActions` takes its body, scrubbed as a log's
  (`scrubText`), as the name (200 characters, none when empty), its own attributes as properties (not `sentry.*`,
  `user.*`, `os.*`, `device.*`, `browser.*`, `server.*` or the mark; keys of 100 characters, 32 of them, strings 200;
  scrubbed), release, environment and trace id as logs do, `platform` from `sentry.sdk.name` (`platformOf`: Web,
  Apple, Android, Flutter, React Native, Server, Unity), `os.name`, `device.model` else `device.family`,
  `browser.name`, the request's country from Cloudflare (`request.cf.country`, none on the cron's retries, never an
  IP), and `user_hash` as `hashUser` of `user.id`, else `user.email`, else `user.name` (what the logs carry for the
  username), numbers as text, as events pick theirs, so actions join a user's errors; `userKeys`, a hash per field
  sent (`userKeysOf` of `user.id`, `user.email`, `user.name` as the username), which `actionUsersStatement` keeps in
  `action_users` (0037) in the same batch, an upsert that moves a key's row (its user and `seen`) only once a day,
  so Find user takes an email too. Checked against
  `@sentry/core` 11.9's `logs/internal.js`. `actionsStatement` writes any number as one `INSERT … SELECT` over
  `json_each`, three rows written an action with the indexes; `storeLogs` puts it in the item's batch, so a retry
  finds both or neither, and counts actions with logs in `project_days.logs`, the daily log limit. The seed runs
  it alone. `actions.test.ts`.

Checked against `@sentry/node` 11.9 (the e2e test) and GlitchTip's incoming event fixtures (`test/fixtures`).
`ingest.test.ts` covers each function, and client keys through `handleIngest` (on `test/fakes.ts`, the Wasm module and
`dispatch` mocked): a second key, one turned off, one past its daily limit; the same event sent twice, stored once and
never failed; what a failing pass costs.
