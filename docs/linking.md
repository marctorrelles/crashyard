# Connecting an app

crashyard speaks Sentry's protocol, so an app connects with the official Sentry SDK pointed at a crashyard DSN. Create a
project with **New project** on the overview. Its settings, under Connect an app, show the DSN and the steps below with
the DSN already filled in. A project can have several keys, one per app or build, under Client keys.

A DSN looks like `https://<public key>@crashyard.example.com/<project id>`. The key is public by design. It ships inside
your apps and only allows sending events.

## Apple

Add [sentry-cocoa](https://github.com/getsentry/sentry-cocoa) with Swift Package Manager, and start it before anything
else runs:

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

## Android

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

## Node.js

```sh
pnpm add @sentry/node
```

```js
import * as Sentry from '@sentry/node'

Sentry.init({ dsn: '<your DSN>', environment: process.env.NODE_ENV ?? 'production' })
```

## Other platforms

Any Sentry SDK works. Set its DSN to the one crashyard gives you.

## Check that events arrive

```sh
curl -X POST 'https://crashyard.example.com/api/<project id>/envelope/?sentry_key=<public key>' \
  --data-binary $'{}\n{"type":"event"}\n{"message":"Hello from curl","level":"info"}\n'
```

The message appears under Issues. Events from the `development` environment are stored like any other, but new routes
only send alerts for `production` until you change them.

## Readable stack traces

Release builds lose their names. Crashes arrive as memory addresses on Apple and in native Android code, as obfuscated
names in Android apps built with R8, and as minified code on the web. Upload the files that map them back, and crashyard
shows function names, files and line numbers just as Sentry does.

Use Sentry's own tools for the uploads: sentry-cli, the Xcode build phase, the Gradle plugin or `@sentry/vite-plugin`.
Point them at crashyard:

```sh
export SENTRY_URL=https://crashyard.example.com/
export SENTRY_ORG=crashyard            # any name works, a deployment is a single organization
export SENTRY_PROJECT=<project slug>
export SENTRY_AUTH_TOKEN=<a token>     # created in Settings, then Tokens, for this project or every project
```

- **Apple.** After archiving, run `sentry-cli debug-files upload --include-sources path/to/dSYMs`.
- **Android.** The Sentry Gradle plugin uploads the ProGuard mapping and NDK symbols on every release build. Point it at
  crashyard with `defaults.url`, `defaults.org` and `defaults.project` in `sentry.properties`.
- **Web.** Use `@sentry/vite-plugin` with `build.sourcemap: true`, or run `sentry-cli sourcemaps inject dist` and then
  `sentry-cli sourcemaps upload dist`.

Crashes from the last 30 days that arrived before their files are processed again once the files are uploaded.

Uploads need the Workers Paid plan. Turning a debug file into a lookup table takes more CPU time than the free plan's
10 ms per request.

### Links to your code

Add the project's repository in its settings, under Source code, for example `https://github.com/owner/repo`. GitHub and GitLab are
supported. Then send each release's commits from its checkout, using the release name the SDK reports:

```sh
sentry-cli releases new -p <project slug> "$RELEASE"
sentry-cli releases set-commits "$RELEASE" --local --initial-depth 100000
```

Each release then lists its commits since the previous one, and stack frames open their line at the release's commit.

crashyard learns which files exist from the commits it receives. That's why the first upload sends the full history,
and later ones only send the commits since the previous release. crashyard never reads the repository itself, so a
private repository needs no token. The links open for anyone who has access to it.

An issue then shows its suspect commits: the commits in its first release that changed a file in its stack. A commit
can also resolve an issue. Put `Fixes CRASHYARD-<issue id>` or `fixes crashyard#<issue id>` in its message, with the
number from the issue's address. When set-commits sends it, the issue is resolved in that release, and its activity
names the commit. An event from that release or a newer one opens it again.

## Logs

Send logs with `Sentry.logger.info('song opened', { song: 42 })`, or with `warn`, `error` and the other levels. They
appear under Logs and can be searched by their attributes, for example `song:42`.

Some SDKs need logs turned on first:

- Older JavaScript SDKs: `enableLogs: true`.
- Apple: `options.experimental.enableLogs = true`.
- Android: `io.sentry.logs.enabled`.

## Cron jobs and uptime

A scheduled job checks in each time it runs, and crashyard alerts you when a run is missed, fails or takes too long:

```js
const checkInId = Sentry.captureCheckIn(
  { monitorSlug: 'nightly-export', status: 'in_progress' },
  { schedule: { type: 'crontab', value: '0 3 * * *' }, timezone: 'Europe/Madrid', checkinMargin: 10, maxRuntime: 30 },
)
// … the job …
Sentry.captureCheckIn({ checkInId, monitorSlug: 'nightly-export', status: 'ok' })
```

The first check-in that includes a schedule creates the monitor. To wrap any command instead, set `SENTRY_DSN` and run
`sentry-cli monitors run nightly-export -- ./export.sh`.

To watch a URL, add an uptime check under Monitors.

## Performance

Set the SDK's sample rate, `options.tracesSampleRate = 0.1` in Swift and Kotlin or `tracesSampleRate: 0.1` in
JavaScript. Screen loads, requests and jobs then appear under Performance, with:

- the count and the p50, p95 and p99 duration for each name,
- the change in p95 since the previous release,
- the ten slowest each day, with their spans.

Crash-free sessions appear under Releases once the SDK sends sessions. The Apple and Android SDKs send them by default.
In the browser and in Node.js, add their session integrations.

crashyard keeps summaries rather than every span. Hourly figures and percentiles are kept for 90 days, and examples for 30.

## Where a build came from

Tag events with `distribution`, for example `app_review`, `testflight`, `app_store`, `play_internal` or `web`.
crashyard then tells you, once per issue, when a crash comes from App Review or TestFlight. Routes send this as the
"App Review or TestFlight crash" alert.
