# What of Sentry's protocol crashyard speaks

crashyard answers the official Sentry SDKs and `sentry-cli` as Sentry does, for what it does. This page says what
works, what's partial and what's ignored. Checked against @sentry/node and @sentry/browser 11.9, sentry-cocoa 9.31,
sentry-android 8.61 and sentry-cli 3.8; the end-to-end tests (`test/`) send through the real Node SDK and CLI.

## SDKs

| SDK                                                                     | Status                                                 | Stacks                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Apple (sentry-cocoa: Swift, Objective-C)                                | works, tested with a real crash                        | symbolicated from uploaded dSYMs                                                         |
| Android (sentry-android, with its NDK part)                             | expected to work: uploads tested, a real crash not yet | Kotlin through an uploaded ProGuard/R8 mapping, native code through uploaded `.so` files |
| JavaScript in a browser (@sentry/browser, and the framework SDKs on it) | works, tested                                          | through uploaded source maps                                                             |
| Node (@sentry/node)                                                     | works, tested                                          | readable as sent                                                                         |
| Python, Ruby, PHP, Go, Java, .NET, Elixir, Rust…                        | expected to work: every SDK sends the same envelopes   | readable as sent, or symbolicated from debug files (Rust, C, C++)                        |
| React Native (Hermes), Flutter (obfuscated), Unity (IL2CPP)             | events arrive and group                                | raw frames: their mappings aren't read yet                                               |

Set the SDK's DSN to the one a crashyard project gives. Nothing else changes.

## Envelope items

| Item                                                                    | What crashyard does                                                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `event`                                                                 | an error, crash or message: scrubbed, symbolicated, grouped into an issue          |
| `attachment`                                                            | kept in R2 (1 MB each at most), shown on its event                                 |
| `feedback`, `user_report`                                               | user feedback, shown on its issue                                                  |
| `log`                                                                   | Sentry's logs: kept, searchable, linked to their trace                             |
| `check_in`                                                              | cron monitors: a check-in with a schedule makes the monitor                        |
| `transaction`                                                           | summarised (counts, percentiles, the slowest few with their spans), not kept whole |
| `span` (span v2, streamed)                                              | as transactions, one per segment span: what the JavaScript SDKs send since v11     |
| `session`, `sessions`                                                   | counted per release and day, for crash-free rates                                  |
| `profile`, `replay`, `replay_recording`, `client_report`, anything else | accepted with a 200 and dropped                                                    |

Rate limits answer as Sentry's do: `429` with `Retry-After` when nothing in an envelope can be kept, and
`X-Sentry-Rate-Limits` by category (`error;default;security;attachment;feedback`, `log_item`, `transaction;span`), so
SDKs stop sending that kind until the next day.

## Endpoints

| Endpoint                                                    | Who calls it                                             | Status                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /api/<project>/envelope/`                             | every current SDK                                        | works                                                                                                |
| `POST /api/<project>/store/`                                | old SDKs                                                 | works                                                                                                |
| `GET /api/0/`                                               | sentry-cli, to check its token                           | works                                                                                                |
| `GET`, `POST /api/0/organizations/<org>/chunk-upload/`      | sentry-cli's uploads                                     | works; the organisation is ignored                                                                   |
| `POST /api/0/projects/<org>/<project>/files/difs/assemble/` | `debug-files upload`, `upload-proguard`                  | works: dSYMs, ELF and ProGuard mappings (tested); PDB expected; Breakpad and source bundles not read |
| `POST /api/0/organizations/<org>/artifactbundle/assemble/`  | `sourcemaps upload`                                      | works, matched by debug id or URL                                                                    |
| `/api/0/organizations/<org>/releases/…`                     | `releases new`, `finalize`, `set-commits`, `deploys new` | releases and their commit kept; deploys answered, not kept                                           |
| Monitors' HTTP check-ins (`/api/<project>/cron/…`)          | curl, without an SDK                                     | not yet: use an SDK or `sentry-cli monitors run`                                                     |
| Everything else under `/api/0/`                             | Sentry's web API                                         | 404                                                                                                  |

## sentry-cli and the build plugins

`SENTRY_URL` set to your crashyard, `SENTRY_AUTH_TOKEN` to a token made in a project's settings, any `SENTRY_ORG`.
`debug-files upload`, `upload-proguard`, `sourcemaps inject` and `upload`, `releases` and `monitors run` work. The
build plugins (Xcode's upload step, the Gradle and Vite plugins) call the same endpoints, so they're expected to work;
they aren't tested here.

## Not there

Seer, session replay, profiles, the issue owners and codeowners, metrics, the web API that
Sentry's own UI and integrations use. crashyard isn't affiliated with Sentry.
