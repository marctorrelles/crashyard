# 1. Speak Sentry's protocol

**Context.** Catching crashes takes a capable SDK. On iOS it needs signal and Mach exception handlers that are safe to
run while the process dies. On Android it needs to catch ANRs and native crashes. Everywhere, it needs offline caching
and retries. Sentry's SDKs do all of this for every major platform, under the MIT license.

**Decision.** crashyard accepts what the Sentry SDKs send, meaning their DSN, envelopes and items. It also answers the
parts of Sentry's API that `sentry-cli` and the build plugins call. We don't write an SDK or a CLI of our own.

**What it costs.** Sentry's protocol changes from time to time. We list the SDK and CLI versions we've checked against,
and tests send through the real `@sentry/node` and `sentry-cli`. The SDKs add a few MB to an app.
