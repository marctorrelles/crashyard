# Sentry compatibility

crashyard answers the official Sentry SDKs and `sentry-cli` the way Sentry does, for the features it has. This page
lists what works, what works in part and what is ignored.

It was checked against @sentry/node and @sentry/browser 11.9, sentry-cocoa 9.31, sentry-android 8.61 and sentry-cli
3.8. The end-to-end tests in `test/` send through the real Node.js SDK and the real CLI.

## SDKs

| SDK                                                                   | Status                                                   | Stack traces                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Apple, sentry-cocoa for Swift and Objective-C                         | Works, tested with a real crash                          | Symbolicated from uploaded dSYMs                                                   |
| Android, sentry-android with its NDK support                          | Expected to work. Uploads are tested, a real crash isn't | Kotlin through an uploaded ProGuard or R8 mapping, native code through `.so` files |
| JavaScript in the browser, @sentry/browser and SDKs built on it       | Works, tested                                            | Through uploaded source maps                                                       |
| Node.js, @sentry/node                                                 | Works, tested                                            | Readable as sent                                                                   |
| Python, Ruby, PHP, Go, Java, .NET, Elixir, Rust…                      | Expected to work, as every SDK sends the same envelopes  | Readable as sent, or symbolicated from debug files for Rust, C and C++             |
| React Native with Hermes, Flutter with obfuscation, Unity with IL2CPP | Events arrive and are grouped                            | Raw frames, as their mappings aren't read yet                                      |

Set the SDK's DSN to the one a crashyard project gives you. Nothing else changes.

## Envelope items

| Item                                                                   | What crashyard does                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `event`                                                                | An error, crash or message. Scrubbed, symbolicated and grouped into an issue           |
| `attachment`                                                           | Stored in R2, up to 1 MB each, and shown on its event with a download                  |
| `feedback`, `user_report`                                              | User feedback, shown on its issue                                                      |
| `log`                                                                  | Sentry logs. Stored, searchable and linked to their trace                              |
| `check_in`                                                             | Cron monitors. A check-in with a schedule creates the monitor                          |
| `transaction`                                                          | Summarized as counts, percentiles and the slowest few with their spans, not kept whole |
| `span`, the streamed span v2 format                                    | Treated as transactions, one per segment span. JavaScript SDKs send these since v11    |
| `session`, `sessions`                                                  | Counted per release and day for crash-free rates                                       |
| `profile`, `replay`, `replay_recording`, `client_report` and any other | Accepted with a 200 and dropped                                                        |

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

A project can have several client keys. A key that's turned off answers `403` with Relay's body for a disabled key.

## Endpoints

| Endpoint                                                    | Called by                                                | Status                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/<project>/envelope/`                             | Every current SDK                                        | Works                                                                                                                                                            |
| `POST /api/<project>/store/`                                | Older SDKs                                               | Works                                                                                                                                                            |
| `GET /api/0/`                                               | sentry-cli, to check its token                           | Works                                                                                                                                                            |
| `GET`, `POST /api/0/organizations/<org>/chunk-upload/`      | sentry-cli uploads                                       | Works. The organization is ignored                                                                                                                               |
| `POST /api/0/projects/<org>/<project>/files/difs/assemble/` | `debug-files upload`, `upload-proguard`                  | Works for dSYMs, ELF files and ProGuard mappings, all tested. PDB is expected to work. Breakpad files and source bundles aren't read                             |
| `POST /api/0/organizations/<org>/artifactbundle/assemble/`  | `sourcemaps upload`                                      | Works, matched by debug ID or URL                                                                                                                                |
| `/api/0/organizations/<org>/releases/…`                     | `releases new`, `finalize`, `set-commits`, `deploys new` | Releases are stored. `set-commits` reads the local git, as no repositories are linked, and its commits and files are stored. Deploys are answered but not stored |
| Monitor check-ins over HTTP, `/api/<project>/cron/…`        | curl, without an SDK                                     | Not supported yet. Use an SDK or `sentry-cli monitors run`                                                                                                       |
| Anything else under `/api/0/`                               | Sentry's web API                                         | Returns 404                                                                                                                                                      |

## sentry-cli and the build plugins

Set `SENTRY_URL` to your crashyard, `SENTRY_AUTH_TOKEN` to a token created in a project's settings, and `SENTRY_ORG` to
any name. These commands work: `debug-files upload`, `upload-proguard`, `sourcemaps inject`, `sourcemaps upload`,
`releases` and `monitors run`.

The build plugins, meaning Xcode's upload step and the Gradle and Vite plugins, call the same endpoints. They are
expected to work, but aren't covered by the tests here.

## Not supported

Seer, session replay, profiling, issue owners and code owners, metrics, and the web API that Sentry's own interface and
integrations use. crashyard isn't affiliated with Sentry.
