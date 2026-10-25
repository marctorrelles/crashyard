# 1. Speak Sentry's protocol

**Context.** An app needs an SDK to catch crashes and send them: on iOS that means signal and Mach exception handlers
that are safe to run while the process dies, on Android ANRs and native crashes, everywhere offline caching and retry.
Sentry's SDKs (MIT) do all of it, for every major platform.

**Decision.** crashyard accepts what the Sentry SDKs send (their DSN, envelopes and items) and answers the parts of
Sentry's API that `sentry-cli` and the build plugins call. We write no SDK and no CLI of our own.

**What it costs.** The protocol changes now and then, so the SDK and CLI versions we've checked are listed, and tests
send through the real `@sentry/node` and `sentry-cli`. The SDKs add a few MB to an app.
