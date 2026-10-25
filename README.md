# crashyard

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/marctorrelles/crashyard/badge)](https://scorecard.dev/viewer/?uri=github.com/marctorrelles/crashyard)

Crash, error and log reporting you run on your own Cloudflare account. Apps send to it with the official Sentry SDKs
(Swift, Android, JavaScript, Node and any other), and it groups crashes into issues, makes them searchable, reads
their stacks from your uploaded debug files and source maps, and tells you when something new breaks. One Cloudflare
Worker, D1 and R2: free on Cloudflare's free plan for most apps.

crashyard is Sentry-compatible and isn't affiliated with Sentry.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/issues-dark.jpg">
  <img alt="crashyard's issues list: crashes from three apps, each with its project, culprit, a 14-day chart and its count" src="docs/images/issues-light.jpg">
</picture>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/marctorrelles/crashyard)

Then put Cloudflare Access in front: [docs/deploying.md](docs/deploying.md) has every step, and the same from a clone.

## What it does

- **Issues:** crashes and errors grouped as Sentry groups them, with resolve (now or in the next release), ignore (for
  good, for a while, for N more events), regressions, merges, notes, tags' top values and Sentry's search syntax.
- **Readable stacks:** dSYMs, ProGuard/R8 mappings, Android native libraries and source maps uploaded with
  `sentry-cli` or the build plugins, unchanged; Sentry's own `symbolic`, compiled to WebAssembly, reads them in the
  worker. An upload after the crash re-reads the crash.
- **Logs:** Sentry's logs, searchable, with a live tail and links to their trace's issues.
- **Monitors:** cron check-ins from the SDKs and `sentry-cli monitors run`, and uptime checks every few minutes.
- **Performance, light:** transactions by p95 per name, how much slower since the release before, the slowest with
  their spans; crash-free sessions per release.
- **Notifications:** ntfy (with Resolve and Ignore buttons on the push), email and webhooks (Slack, Discord, JSON),
  routed by kind, project, level and environment, with quiet hours.
- **Releases:** what's new, back and gone in each release against the one before, and a push when a crash comes from
  App Review or TestFlight.
- **An MCP server**, so an agent can search issues and logs, read a symbolicated stack, resolve and note
  ([docs/mcp.md](docs/mcp.md)).

## SDKs

|                                          | Status                                    | Stacks                                     |
| ---------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| Apple (sentry-cocoa)                     | works                                     | symbolicated from dSYMs                    |
| Android (sentry-android, with NDK)       | expected to work, not yet seen end to end | from the R8 mapping and native `.so` files |
| JavaScript in a browser                  | works                                     | from source maps                           |
| Node                                     | works                                     | as sent                                    |
| Python, Ruby, PHP, Go, Java, .NET, Rust… | expected to work                          | as sent, or from debug files               |

Linking an app: [docs/linking.md](docs/linking.md). What of Sentry's protocol and API works, exactly:
[docs/sentry-compatibility.md](docs/sentry-compatibility.md).

## Privacy

No telemetry: crashyard sends nothing about you or your apps anywhere. The one request it makes on its own is asking
GitHub, once a day, whether a newer release is out, to say so on the home page. It keeps no IP addresses, keeps a
user only as the app's id hashed, and scrubs what looks like a password, token or email from events and logs.

## Developing

```sh
pnpm install
pnpm dev      # the dashboard at http://localhost:3000, with local D1 and R2
pnpm seed     # a month of made-up crashes, logs and transactions in it
pnpm check    # lint, format, types, unused code, tests and the build: what CI runs
```

How it fits together: [docs/architecture.md](docs/architecture.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
Upgrading a deployment: [docs/upgrading.md](docs/upgrading.md). Licensed under [MIT](LICENSE).
