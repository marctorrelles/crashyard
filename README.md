# crashyard

Crash, error and log reporting you run on your own Cloudflare account. Apps send to it with the official Sentry SDKs
(Swift, Android, JavaScript, Node and any other), and it groups crashes into issues, makes them searchable, and tells
you when something new breaks. One Cloudflare Worker, D1 and R2: free on Cloudflare's free plan for most apps.

crashyard is Sentry-compatible and isn't affiliated with Sentry.

> Work in progress. Deploying your own: [docs/deploying.md](docs/deploying.md). Linking an app:
> [docs/linking.md](docs/linking.md). An agent's way in: [docs/mcp.md](docs/mcp.md).

## Developing

```sh
pnpm install
pnpm dev      # the dashboard at http://localhost:3000, with local D1 and R2
pnpm check    # lint, format, types, unused code, tests and the build: what CI runs
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
