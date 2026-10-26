# Linking an app

crashyard speaks Sentry's protocol: an app links with the official Sentry SDK, pointed at a crashyard DSN. Make a
project in the dashboard (Projects → New project); its Settings page shows the DSN and these same steps with it
filled in.

A DSN looks like `https://<public key>@crashyard.example.com/<project id>`. The key is public: it ships inside apps,
and only lets them send.

## Apple (Swift)

Add [sentry-cocoa](https://github.com/getsentry/sentry-cocoa) with Swift Package Manager, and start it first thing:

```swift
import Sentry

SentrySDK.start { options in
    options.dsn = "<your DSN>"
    #if DEBUG
    options.environment = "development"
    #endif
    options.sendDefaultPii = false
}
```

## Android (Kotlin)

```kotlin
// build.gradle.kts
implementation("io.sentry:sentry-android:8.+")
```

```xml
<!-- AndroidManifest.xml, inside <application> -->
<meta-data android:name="io.sentry.dsn" android:value="<your DSN>" />
<meta-data android:name="io.sentry.send-default-pii" android:value="false" />
```

## Browser

```sh
pnpm add @sentry/browser
```

```js
import * as Sentry from '@sentry/browser'

Sentry.init({ dsn: '<your DSN>', environment: import.meta.env.MODE, release: import.meta.env.VITE_RELEASE })
```

## Node

```sh
pnpm add @sentry/node
```

```js
import * as Sentry from '@sentry/node'

Sentry.init({ dsn: '<your DSN>', environment: process.env.NODE_ENV ?? 'production' })
```

## Readable stacks

Release builds ship without names: crashes arrive as addresses (Apple, NDK), obfuscated names (Android with R8) or
minified code (web). Upload what maps them back and crashyard shows functions, files and lines, as Sentry does,
with Sentry's own tools: sentry-cli, the Xcode build phase, the Gradle plugin, `@sentry/vite-plugin`. Point them here:

```sh
export SENTRY_URL=https://crashyard.example.com/
export SENTRY_ORG=crashyard            # any name: a deployment is one organisation
export SENTRY_PROJECT=<project slug>
export SENTRY_AUTH_TOKEN=<a token>     # created in the project's settings, under Symbols and source maps
```

- Apple: `sentry-cli debug-files upload --include-sources path/to/dSYMs` after archiving.
- Android: the Sentry Gradle plugin uploads the ProGuard mapping and NDK symbols on release builds (point it here
  in `sentry.properties`: `defaults.url`, `defaults.org`, `defaults.project`).
- Web: `@sentry/vite-plugin` with `build.sourcemap: true`, or `sentry-cli sourcemaps inject dist` then
  `sentry-cli sourcemaps upload dist`.

Crashes that came in before their files did are read again when the files arrive (the last 30 days).

### Linking to the code

Give the project its repository in its settings (GitHub or GitLab, like `https://github.com/owner/repo`), and with
each release send its commits from its checkout, the release named as the SDK names it:

```sh
sentry-cli releases new -p <project slug> "$RELEASE"
sentry-cli releases set-commits "$RELEASE" --local --initial-depth 100000
```

The release then lists its commits since the one before, and a stack's frames open their line at the release's commit.
crashyard learns the repository's files from the commits, so the first time send the whole history (the depth); after
that only the commits since the release before go. Nothing reads the repository itself, so a private one needs no
token: the links open for whoever can see it.

Uploads need Workers Paid: turning a debug file into a lookup table takes more CPU than the free plan's 10 ms a
request.

## Logs

The SDKs send logs with `Sentry.logger.info('song opened', { song: 42 })` (and `warn`, `error`…); they show under
Logs, searchable by their attributes (`song:42`). Turn them on where the SDK needs it (`enableLogs: true` in older
JavaScript SDKs, `options.experimental.enableLogs = true` on Apple, `io.sentry.logs.enabled` on Android).

## Cron jobs and uptime

A scheduled job checks in, and crashyard tells you when a run is missed, fails or takes too long:

```js
const checkInId = Sentry.captureCheckIn(
  { monitorSlug: 'nightly-export', status: 'in_progress' },
  { schedule: { type: 'crontab', value: '0 3 * * *' }, timezone: 'Europe/Madrid', checkinMargin: 10, maxRuntime: 30 },
)
// … the job …
Sentry.captureCheckIn({ checkInId, monitorSlug: 'nightly-export', status: 'ok' })
```

The first check-in with a schedule makes the monitor. Around any command: `sentry-cli monitors run nightly-export --
./export.sh` (with `SENTRY_DSN` set). URLs to check every few minutes are added under Monitors.

## Performance

Set the SDK's `tracesSampleRate` (`options.tracesSampleRate = 0.1` in Swift and Kotlin, `tracesSampleRate: 0.1` in
JavaScript) and its screen loads, requests and jobs show under the project's Performance tab: count, p50/p95/p99 per
name, the change in p95 since the release before, and the ten slowest a day with their spans. Crash-free sessions show
on Releases once the SDK sends sessions (Apple and Android do by default; browser and Node with their session
integrations). crashyard keeps summaries, not every span: hours and percentiles for 90 days, examples for 30.

## Anything else

Any Sentry SDK works: set its DSN to crashyard's.

## Check it arrives

```sh
curl -X POST 'https://crashyard.example.com/api/<project id>/envelope/?sentry_key=<public key>' \
  --data-binary $'{}\n{"type":"event"}\n{"message":"Hello from curl","level":"info"}\n'
```

It shows up under Issues. Events from the `development` environment are kept like any other, but routes send
notifications for `production` only unless you change them.

## Where a build came from

Tag events with `distribution` (`app_review`, `testflight`, `app_store`, `play_internal`, `web`…) and crashyard tells
you, once per issue, when a crash comes from App Review or TestFlight (the route kind "App Review or TestFlight
crash").
