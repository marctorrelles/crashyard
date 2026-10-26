# Test

Tests that run the worker. Unit tests live beside the code (`src/**/*.test.ts`).

- `ingest.e2e.test.ts`: the official `@sentry/node` (errors, logs, check-ins, spans) sending to `vite dev` (ports
  3999, and 3998 for a stub ntfy) with its own state in `.wrangler/e2e`, wiped each run; the cron at set times
  (`/__dev/cron?now=`: missed check-ins, uptime, Monday's summary). Seeds rows through `getPlatformProxy`. Keep it
  under 30 seconds.
- `dev.ts`: `startDev(port, state)`: a dev server with its own state, wiped each run, and project 1 (`e2e`).
- `uploads.e2e.test.ts`: sentry-cli 3.8 uploading a dSYM (after the crash that needed it: re-symbolicated and
  regrouped), source maps (`sourcemaps inject` then `upload`), a ProGuard mapping, and `releases set-commits --local`
  from a git repository made in the test (`GIT_DIR`: the second release gets only the commits since the first); port 3997.
- `fixtures/native`: `crash.c` and its dSYM (`clang -g -O0 -arch arm64 -c`, link, `dsymutil`): `render_voice` at
  0x460 (crash.c:5), `main` at 0x47c. `fixtures/web`: `app.ts` and its esbuild bundle and map.
  `fixtures/proguard`: a mapping with an inlined call.
- `fixtures/` (the rest): events as SDKs send them, from GlitchTip (MIT, see its README). Not formatted by Prettier.
