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
