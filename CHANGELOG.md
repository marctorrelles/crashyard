# Changelog

Every change worth knowing, newest first. Versions follow [Semantic Versioning](https://semver.org/). Release notes are
written from the commit messages, and a release whose migration changes data says so at its top.

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
