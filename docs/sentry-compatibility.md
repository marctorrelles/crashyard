# Sentry compatibility

crashyard answers the official Sentry SDKs and `sentry-cli` the way Sentry does, for the features it has. This page
lists what works, what works in part and what is ignored.

It was checked against @sentry/node and @sentry/browser 11.9, sentry-cocoa 9.31, sentry-android 8.61 and sentry-cli
3.8. The end-to-end tests in `test/` send through the real Node.js SDK and the real CLI.

On October 27, 2026, each server and cross-platform SDK sent the same things to crashyard: an error from two nested
functions, a message, a transaction with nested spans and a log, all inside a trace continued from a `sentry-trace`
header. Every one arrived, grouped, with its stack trace, and in its trace. The versions were sentry-python 2.73,
sentry-ruby 7.1, sentry-php 4.34, sentry-go 0.50, sentry-java 8.62, sentry-dotnet 6.12, sentry-elixir 14.0,
sentry-rust 0.49 and sentry-dart 10.2.

## SDKs

| SDK                                                                   | Status                                                   | Stack traces                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Apple, sentry-cocoa for Swift and Objective-C                         | Works, tested with a real crash                          | Symbolicated from uploaded dSYMs                                                   |
| Android, sentry-android with its NDK support                          | Expected to work. Uploads are tested, a real crash isn't | Kotlin through an uploaded ProGuard or R8 mapping, native code through `.so` files |
| JavaScript in the browser, @sentry/browser and SDKs built on it       | Works, tested                                            | Through uploaded source maps                                                       |
| Node.js, @sentry/node                                                 | Works, tested                                            | Readable as sent                                                                   |
| Python, Ruby, PHP, Go, Java, .NET, Elixir, Rust and Dart              | Works, tested with errors, transactions, logs and traces | Readable as sent, or symbolicated from debug files for Rust, C and C++             |
| React Native with Hermes, Flutter with obfuscation, Unity with IL2CPP | Events arrive and are grouped                            | Raw frames, as their mappings aren't read yet                                      |

Set the SDK's DSN to the one a crashyard project gives you. Nothing else changes.

A few SDKs behave in ways worth knowing, and Sentry sees the same:

- sentry-dart 10 sends spans as they finish. It can't yet continue a trace from an incoming header, and
  `Sentry.close` can return before its last spans and logs are sent.
- sentry-elixir sends transactions through OpenTelemetry. Add `opentelemetry`, `opentelemetry_api`,
  `opentelemetry_exporter` and `opentelemetry_semantic_conventions`, and set Sentry's span processor and sampler. Its
  logs carry a trace of their own rather than the active span's.
- sentry-rust shows a panic's stack from its own panic handler down, and an error sent with `capture_error` has no
  stack trace.
- sentry-java and sentry-ruby mark frames as your code only when their in-app options name your packages or project
  root.

## Envelope items

| Item                                                                   | What crashyard does                                                                                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`                                                                | An error, crash or message. Scrubbed, symbolicated and grouped into an issue                                                                                                     |
| `attachment`                                                           | Stored in R2, up to 1 MB each, and shown on its event with a download                                                                                                            |
| `feedback`, `user_report`                                              | User feedback, shown on its issue                                                                                                                                                |
| `log`                                                                  | Sentry logs. Stored, searchable and linked to their trace                                                                                                                        |
| `check_in`                                                             | Cron monitors. A check-in with a schedule creates the monitor                                                                                                                    |
| `transaction`                                                          | Summarized as counts, percentiles and the slowest few with their spans, not kept whole. Its `measurements` give web and mobile vitals                                            |
| `span`, the streamed span v2 format                                    | Treated as transactions, one per segment span. JavaScript SDKs send these since v11, sentry-dart since 10. Spans that come before their segment are held for a day until it does |
| `session`, `sessions`                                                  | Counted per release and day for crash-free rates, adoption and users                                                                                                             |
| `profile`, `replay`, `replay_recording`, `client_report` and any other | Accepted with a 200 and dropped                                                                                                                                                  |

An event keeps its `request`, meaning the method, URL, query string, headers and up to 8 KB of body, and up to 16 KB of
its `extra` data. Both are scrubbed like the rest of the event, and headers such as `Authorization` and `Cookie` are
filtered.

Attachments are listed on their event. Screenshots in PNG, JPEG, GIF or WebP are shown, and the view hierarchy that
sentry-cocoa and sentry-android attach is shown as a tree. Every other file, SVG and HTML included, only downloads.

An event keeps up to 32 of its threads, each with its last 100 frames. An event larger than 900 KB is cut down to fit,
starting with old breadcrumbs and frames far from the crash, and the event names what was cut. Its full envelope is
still kept in R2. The crashed thread's stack is shown as the
exception's, and the others are listed under it.

An envelope is accepted before it's processed, as Sentry's Relay does. If storing an item fails, the answer is still a
`200` with the event ID, and crashyard tries the item again within a few minutes, up to five times.

Rate limits answer the way Sentry's do. When nothing in an envelope can be kept, the answer is a `429` with
`Retry-After`. `X-Sentry-Rate-Limits` names each category that is over its limit, as
`error;default;security;attachment;feedback`, `log_item` or `transaction;span`, so SDKs stop sending that kind until the
next day. A client key past its own daily event limit gets the same answer for errors, scoped to the key.

A project's grouping rules use Sentry's syntax for fingerprint rules and stack trace rules. The matchers are
`error.type`, `error.value`, `message`, `level`, `tags.<name>` and the `stack.*` ones with `app` and `family`, and the
actions are `+app`, `-app`, `+group` and `-group`. Logger and category matchers, sibling frames, `max-frames` and
custom titles aren't supported yet, and the settings page says so on the line that uses them.

A project's inbound filters drop events as Sentry's do, before they're stored and without counting towards the daily
limits: browser extensions, localhost, legacy browsers, web crawlers, health-check transactions, React hydration
errors, `ChunkLoadError`, and error messages and releases by pattern. They use the lists in Sentry's Relay. With
allowed domains set, a request whose `Origin` or `Referer` isn't one of them is refused with a `403`, as Relay does.
Deleting an issue with "Delete and discard future events" drops its later events the same way.

A transaction's `measurements` give the web vitals LCP, INP, CLS, FCP and TTFB, and the mobile vitals cold and warm
app start, time to initial and full display, and slow and frozen frames. Each is shown as its 75th percentile, rated
by Sentry's thresholds. Streamed spans carry no measurements, so a browser SDK with span streaming turned on sends no
vitals yet.

A check-in over HTTP without a `check_in_id` finishes the monitor's run in progress, as Sentry pairs them. A CSP report
becomes an event of type `csp`, titled after Sentry's, such as "Blocked 'script' from 'cdn.example.com'", and grouped
by the directive and the blocked host. Both take the same path as envelopes: the same key check, daily limits and
retries.

A session's `did`, the distinct ID the SDK sends, counts users per release and day for crash-free users and active
users. Only a hash of it is stored. A session without one counts no user.

An event's user is kept the same way. Its `id`, `email`, `username` and `name` are each stored only as a hash, and
its `ip_address` isn't stored at all. Search for one person's issues or events with `user:` and any of those values,
such as `user:8f3a2c` or `user:ana@example.com`, on Issues or in Explore. `user.id:`, `user.email:`, `user.username:`
and `user.name:` look in one field only. crashyard hashes what you type and compares the hashes, so a search matches
the whole value exactly and takes no wildcards. An email matches in any case. Events stored by an older crashyard
kept only one hash, of the `id`, else the `email`, else the `username`, and are found by that value only.

A project can have several client keys. A key that's turned off answers `403` with Relay's body for a disabled key.

## Endpoints

| Endpoint                                                    | Called by                                                | Status                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/<project>/envelope/`                             | Every current SDK                                        | Works                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/<project>/store/`                                | Older SDKs                                               | Works                                                                                                                                                                                                                                                                                                                                  |
| `GET /api/0/`                                               | sentry-cli, to check its token                           | Works                                                                                                                                                                                                                                                                                                                                  |
| `GET`, `POST /api/0/organizations/<org>/chunk-upload/`      | sentry-cli uploads                                       | Works. The organization is ignored                                                                                                                                                                                                                                                                                                     |
| `POST /api/0/projects/<org>/<project>/files/difs/assemble/` | `debug-files upload`, `upload-proguard`                  | Works for dSYMs, ELF files and ProGuard mappings, all tested. PDB is expected to work. Breakpad files and source bundles aren't read                                                                                                                                                                                                   |
| `POST /api/0/organizations/<org>/artifactbundle/assemble/`  | `sourcemaps upload`                                      | Works, matched by debug ID or URL                                                                                                                                                                                                                                                                                                      |
| `/api/0/organizations/<org>/releases/…`                     | `releases new`, `finalize`, `set-commits`, `deploys new` | Releases are stored. Use `set-commits --local`: crashyard has no repository integrations, so it reads the commits from your checkout. Its commits and the files each changed are stored. A message with `Fixes CRASHYARD-<id>` resolves that issue in the release. `deploys new` and `deploys list` store and list a release's deploys |
| `GET`, `POST /api/<project>/cron/<slug>/<key>/`             | curl, without an SDK                                     | Works. `?status=`, `check_in_id`, `environment` and `duration`, or the check-in as JSON with its `monitor_config`, which creates the monitor. Answers `202`                                                                                                                                                                            |
| `POST /api/<project>/security/`                             | Browsers' CSP `report-uri` and `report-to`               | Works for CSP violations, in both the `csp-report` and the Reporting API shapes. Other report types are dropped                                                                                                                                                                                                                        |
| Anything else under `/api/0/`                               | Sentry's web API                                         | Returns 404                                                                                                                                                                                                                                                                                                                            |

## Importing from Sentry

A project's settings can import its issues from a Sentry project, on sentry.io or your own Sentry. It needs an auth
token with the `event:read` and `project:read` scopes, used for that import only and never stored.

Each issue comes with its latest event, its event and user counts, when it was first and last seen, whether it's
resolved or ignored, and its comments as notes. crashyard groups the event itself, so the next events the SDK sends of
the same error join the imported issue. Older events, attachments and the charts of past days aren't imported, and
issues past the project's event retention are pruned as usual. Importing again skips the issues already imported.

The import runs while its page is open, 10 issues at a time. If it stops, it continues from where it was.

## Forwarding to Sentry

To run crashyard and Sentry side by side, give a project the DSN of its Sentry project in its settings, under Sentry.
Every envelope the project accepts then goes on to Sentry as the app sent it. That happens before crashyard's daily
limits and inbound filters, as Sentry applies its own. Sentry doesn't get the sender's IP address. Each envelope is
sent once, and if Sentry is down or refuses it, crashyard still keeps it. Failed runs of Cloudflare Workers that come
through a Tail Worker aren't forwarded. Clear the DSN to stop.

## sentry-cli and the build plugins

Set `SENTRY_URL` to your crashyard, `SENTRY_AUTH_TOKEN` to a token created in Settings, then Tokens, and `SENTRY_ORG` to
any name. These commands work: `debug-files upload`, `upload-proguard`, `sourcemaps inject`, `sourcemaps upload`,
`releases` and `monitors run`.

The build plugins, meaning Xcode's upload step and the Gradle and Vite plugins, call the same endpoints. They are
expected to work, but aren't covered by the tests here.

## Not supported

Seer, session replay, profiling, issue owners and code owners, metrics, and the web API that Sentry's own interface and
integrations use. crashyard isn't affiliated with Sentry.
