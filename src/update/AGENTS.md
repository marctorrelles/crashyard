# Update

Whether a newer crashyard is out, and installing it from the dashboard. The owner's dialog is
`src/components/update.tsx`, the server functions `getUpdate`, `checkForUpdate`, `connectCloudflare`,
`disconnectCloudflare`, `setAutoUpdate` and `installUpdate` in `src/fns.ts` (owners only), the daily job in `src/server.ts`.

- `check.ts`: the repo's releases (`REPO`), 100 at most, asked once a day through the Cache API, kept trimmed (each
  one's tag, link, assets, and its notes only as whether they carry `BUILDER_NOTE`); nothing about the deployment is
  sent. `pick` takes the newest past this version, drafts and pre-releases aside: `builder` when any release up to it
  changes the SymCache builder (so skipping one still counts), `major`, and `bundle`, its `crashyard.json.gz` with the
  SHA-256 GitHub keeps of it (`digest`), null for a release without one. `latest` gives it with `checkedAt`, from the one
  cached answer (`x-checked-at`, set only when GitHub answered; a failure is kept an hour as no update and no time, so
  it never reads as up to date); `latest(true)`, `checkForUpdate`, an owner's Check now on Settings, General, asks
  again and replaces the answer only with GitHub's, else throws `UNREACHABLE`, so a refusal (60 an hour unsigned, per
  address, which Workers share) never wipes a known update. The sidebar and Settings, General show it.
- `install.ts`: `connect` (the token's accounts, the one with the Worker by name whose `DB` binding it reads, then
  that database through D1's API; kept as `update.cloudflare`, never sent back to the page), `refusal` (why an update
  needs a deploy: no build, a builder change where the builder runs, a binding the worker lacks), `download` (the
  build if its SHA-256 is GitHub's and it names the version), `install` (as `pnpm run deploy`: new migrations through
  D1's query API, each with its `d1_migrations` row as wrangler adds it; the assets through an upload session, hashed
  as Cloudflare's direct upload does, SHA-256 of the base64 and the extension, the first 32 hex digits; the worker by
  a `PUT` of its modules, `.wasm` as `application/wasm`, the rest `application/javascript+module`, with
  `keep_bindings` of every type it has, so bindings, vars and secrets stay, its logpush, observability, placement and
  tail consumers copied, `containers` for `SymcacheBuilder` where it runs, as wrangler sends it, or the Durable
  Object would lose its container; then the crons if they differ; `update.installed` for `scripts/deploy-guard.mjs`)
  and `autoUpdate` (the cron's, daily from 03:40 UTC, never in the demo (`DEMO=1`, `src/demo.ts`), where `update.auto`: never a major version; a failure kept as
  `update.failed` for the dialog). A failure before the `PUT` leaves the worker as it was; the migrations only add, so
  the running version takes them.
- `check.test.ts`, `install.test.ts`: picking, the kept answer and Check now's failure, refusals, the digest. Checked live on 2026-10-28 against a throwaway
  Worker (one migration behind, a secret, another cron, then with the builder's container): the migration applied, the
  assets served with their types, the secret and bindings kept, the cron changed, and a 107 MB dSYM uploaded through
  the builder after.

Installing needs Workers Paid: hashing and encoding a few MB takes more than Free's 10 ms of CPU.
