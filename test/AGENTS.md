# Test

Tests that run the worker. Unit tests live beside the code (`src/**/*.test.ts`).

- `ingest.e2e.test.ts`: the official `@sentry/node` (errors, logs, check-ins, spans) sending to `vite dev` (ports
  3999, and 3998 for a stub Telegram Bot API) with its own state in `.wrangler/e2e`, wiped each run; the cron at set times
  (`/__dev/cron?now=`: missed check-ins, uptime, Monday's summary, an envelope D1 refused, through a trigger on
  `events`, stored once by the cron's retry); check-ins over HTTP (a JSON POST with
  `monitor_config`, then curl's GETs) and CSP reports in both shapes; a watched Worker's run out of CPU time through `/__dev/tail`. Seeds rows through `getPlatformProxy`. Keep it
  under 30 seconds.
- `fakes.ts`: for unit tests, `sqliteD1()` (node:sqlite in memory with every migration, `.sqlite` for seeding; a
  statement binding more than 100 values throws, as D1's do) and
  `memoryR2()` (a map with `customMetadata`, `.objects`, `head`, ranges, `body` as a stream, and multipart uploads):
  only what `src/` calls.
- `dev.ts`: `startDev(port, state)`: a dev server with its own state, wiped each run, and project 1 (`e2e`), whose
  key `KEY` 0013's trigger puts in `project_keys`.
- `uploads.e2e.test.ts`: sentry-cli 3.8 uploading a dSYM (after the crash that needed it: re-symbolicated and
  regrouped), source maps (`sourcemaps inject` then `upload`), a ProGuard mapping, and `releases set-commits --local`
  from a git repository made in the test (`GIT_DIR`: the second release gets only the commits since the first, and
  each commit's files and their A or D land in `commit_files`), `deploys new` and `deploys list` (`-t` as start and
  finish), and a
  token of one project refused for another's upload; port 3997.
- `big-dsym.e2e.test.ts`: opt-in (`BIG_DSYM=<a dSYM over 48 MB> CONTAINERS=1`, Docker running; skipped otherwise):
  sentry-cli uploads it through the SymCache builder's container, and a crash at an address reads as the SymCache
  the Wasm module makes in Node says; port 3996. With `CONTAINERS=1`, `startDev` waits up to 10 minutes, the
  image's build. Checked with Caliu's 107 MB macOS dSYM.
- `fixtures/native`: `crash.c` and its dSYM (`clang -g -O0 -arch arm64 -c`, link, `dsymutil`): `render_voice` at
  0x460 (crash.c:5), `main` at 0x47c. `fixtures/web`: `app.ts` and its esbuild bundle and map.
  `fixtures/proguard`: a mapping with an inlined call (the test retraces a thread and an exception class too).
- `fixtures/` (the rest): events as SDKs send them, from GlitchTip (MIT, see its README). Not formatted by Prettier.
