# Changelog

Every change worth knowing, newest first. Versions follow [Semantic Versioning](https://semver.org/). Release notes are
written from the commit messages, and a release whose migration changes data says so at its top.

## [0.3.0](https://github.com/marctorrelles/crashyard/compare/v0.2.0...v0.3.0) (2026-11-04)


### Features

* **grouping:** group events as Sentry does, for every platform ([#19](https://github.com/marctorrelles/crashyard/issues/19)) ([5f79a49](https://github.com/marctorrelles/crashyard/commit/5f79a49e6ab2f54c2ada2df7dcc88827d35a3a4d))
* **settings:** an Updates card with Check now, and a clearer Public URL ([#17](https://github.com/marctorrelles/crashyard/issues/17)) ([36850b4](https://github.com/marctorrelles/crashyard/commit/36850b43dab7f5182d3b75a2456a836e6bcdb9f6))

## [0.2.0](https://github.com/marctorrelles/crashyard/compare/v0.1.1...v0.2.0) (2026-11-04)


### Features

* delete debug files and source maps no lookup has used for the project's retention ([#14](https://github.com/marctorrelles/crashyard/issues/14)) ([821d85c](https://github.com/marctorrelles/crashyard/commit/821d85c86f986eb2aca1a15544e115ce0a100cb8))


### Bug Fixes

* **symbols:** symbolicate with the dSYM, not the executable sent beside it ([#16](https://github.com/marctorrelles/crashyard/issues/16)) ([b2fdb83](https://github.com/marctorrelles/crashyard/commit/b2fdb8306b04bf24eca01194500efb53023acd3a))


### Performance Improvements

* **ingest:** hold small envelopes in D1 instead of R2 ([#12](https://github.com/marctorrelles/crashyard/issues/12)) ([d46fe2d](https://github.com/marctorrelles/crashyard/commit/d46fe2ddd160688a6ac7117bc8f732ecbef7ba1d))
* **ingest:** stop keeping a raw copy of every envelope in R2 ([#13](https://github.com/marctorrelles/crashyard/issues/13)) ([ca28023](https://github.com/marctorrelles/crashyard/commit/ca28023f002bd97112a2625e4a24a694d899c527))

## [0.1.1](https://github.com/marctorrelles/crashyard/compare/v0.1.0...v0.1.1) (2026-11-04)


### Bug Fixes

* **symcache:** zstd 0.13.4 and zstd-safe 7.4, for RUSTSEC-2026-0391 and 0395 to 0406 ([87e674e](https://github.com/marctorrelles/crashyard/commit/87e674e3890d8050f062d54e58702cf440146c82))

## 0.1.0 (2026-11-04)

The first public release of crashyard.

crashyard is a crash, error and log reporter that runs on your own Cloudflare account. Your apps keep the official
Sentry SDKs and sentry-cli. Only the DSN changes.

- Issues, events, logs, performance, releases, uptime and cron monitors, status pages, dashboards and product analytics.
- Symbols and source maps for iPhone, Android, web and server apps.
- Alerts by Telegram, email, webhooks and push notifications.
- Agents such as Claude Code can read and triage it over MCP.

To get started, read [Deploying crashyard](https://github.com/marctorrelles/crashyard/blob/main/docs/deploying.md) or use
the Deploy to Cloudflare button in the README. To look around first, open the [live demo](https://demo.crashyard.dev).
