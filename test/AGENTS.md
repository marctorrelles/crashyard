# Test

Tests that run the worker. Unit tests live beside the code (`src/**/*.test.ts`).

- `ingest.e2e.test.ts`: the official `@sentry/node` sending to `vite dev` (ports 3999, and 3998 for a stub ntfy) with
  its own state in `.wrangler/e2e`, wiped each run. Seeds rows through `getPlatformProxy`. Keep it under 30 seconds.
- `fixtures/`: events as SDKs send them, from GlitchTip (MIT, see its README). Not formatted by Prettier.
