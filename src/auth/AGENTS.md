# Auth

Who's signed in to the dashboard: crashyard's own passkeys, Sign in with GitHub and sessions. Decision:
`docs/decisions/0005-own-sign-in.md` (Cloudflare Access, 0003, was the way in before, and is gone).

- `session.ts`: `whoIs(request, env, dev, now)`, the one answer `src/server.ts` acts on: `{ email, role, userId?,
session?, cookie? }` or null. A dev server (`import.meta.env.DEV`, false in every build) is `dev@localhost`, an owner,
  unless `AUTH` is `crashyard` (`AUTH=crashyard SETUP_CODE=… pnpm dev`, `vite.config.ts` passes both; `AUTH` is a dev
  switch only, not in `wrangler.jsonc`). Everyone else: the `crashyard_session` cookie (HttpOnly, SameSite=Lax so a link from elsewhere opens signed in, Secure on https, 90 days), looked up by its
  SHA-256 (`src/data/people.ts`); renewed when under 60 days are left, at most once a day, so reading pages rarely
  writes; `cookie` is then the Set-Cookie to send.
- `passkeys.ts`: `handleAuth(path, ctx)`, `/auth/*`, plain JSON POSTs ahead of Start, refused unless `Origin` is the
  request's own. Each ceremony is `<kind>/options` (a challenge in `challenges`, five minutes, one use: `takeChallenge`
  deletes it) then `<kind>/verify` (`@simplewebauthn/server`; resident keys required, user verification preferred,
  attestation none). `setup` (only while there's no one, with the worker secret `SETUP_CODE`, declared in
  `src/secrets.d.ts` as `wrangler types` can't see secrets, compared as digests of the code without
  dashes or spaces; the first owner, signed in, ten recovery codes), `signin` (any of this crashyard's passkeys,
  picked by the browser: no email to type; the counter written back), `passkeys` (another for whoever is signed in,
  their others excluded), `invite` (the invite taken first, `useInvite` only while unused and unexpired, so one use
  even from two tabs, then the person with its role, and given back, `unuseInvite`, when the person can't be made; an email it names is the only one it takes), `recover` (email and
  a recovery code, once per code) and `signout` (a form POST: the session deleted, the cookie cleared, 303 to
  `/signin`). The relying party is `PUBLIC_URL`'s host (not on a dev server), else the request's: a domain change means
  new passkeys. The authenticator's user handle is SHA-256 of `crashyard:<email>`, so a device keeps one per person.
- **Fail closed:** with no session, crashyard opens only `/signin`, `/setup` and `/invite/<token>` (pages redirect
  there: `/setup` while there's no one, else `/signin?next=`; server functions, `/mcp` and other methods get 401);
  signed in, those three redirect to `/`.
- `src/server.ts` passes who's asking on as headers, after dropping every `x-crashyard-*` sent from outside:
  `x-crashyard-viewer` (the email: activity, assignees, preferences and bookmarks are by email), `x-crashyard-role`,
  `x-crashyard-user` and `x-crashyard-session` (neither on a dev server). Server code reads them only there.
- Roles (`src/data/people.ts`, `ROLES`, `reaches`): owner (everything, People; at least one always), admin (projects,
  keys, channels, routes, alerts, monitors, upload tokens, debug files, defaults, privacy, test sends), member (resolve, ignore, assign, merge, link, notes, dashboards), viewer (reads, their own preferences,
  bookmarks, saved searches and sign-in). Every POST server function in `src/fns.ts` names its least role,
  `.middleware([signedIn | member | admin | owner])` (or `reads`, below, Demo); `sign-in.test.ts` fails on one that doesn't, on one declared
  any other way than a POST with a role or a GET named `get…`, and on a server function outside `src/fns.ts`.
- **Demo** (`src/demo.ts`, on where the deployment's `vars` set `DEMO=1`: demo.crashyard.dev; `DEMO=1 pnpm dev`
  locally): read-only, no accounts. `whoIs` reads only the `crashyard_demo` cookie (HttpOnly, Lax, a day), which makes
  everyone one viewer, `visitor@demo.crashyard.dev`, with no user or session; a session cookie is never read. `demoGate`,
  first in `fetch`: ingest's four doors 403 before the body (CORS on); `POST /auth/demo` (Origin checked, the cookie,
  303 to `nextPath(next)`, the Enter demo form on `/signin`) and `POST /auth/signout` (cleared, 303 `/signin`); any
  other `/auth/*`, GitHub's too, 404; `/setup` and `/invite/*` 303 to `/signin`; `/mcp` without a `cyp_` token as the
  viewer, change tools refused with the demo's sentence. The signed-out redirect never picks `/setup` there. In
  `src/fns.ts`, `as()` refuses every server function in the demo (`DEMO_REFUSAL`, whatever the role) but `reads`, for
  GETs that need someone signed in and the three POSTs that only read or set the viewer's cookies: `previewWidget`,
  `getPlan`, `savePreference` (theme and style, in cookies only; `getSidebar` reads them back from there and writes
  none). `getIssue` marks nothing viewed, `getPush` makes no keys. `demoCache`: a GET server function's answer, for
  the demo's viewer, kept a minute in the Cache API, keyed by its URL and the cookies server functions read (`theme`,
  `style`, `tz`, `crashyard_project`, `sidebar_state`), `no-store` to the browser, `x-crashyard-demo-cache` on a dev
  server; a first page's server render isn't. `demo.test.ts`: the gate's answers, that it's
  asked only in the demo, the refusal for every role, and the cache's key; `sign-in.test.ts`: `whoIs` in and out of it, and the exact
  `reads` list.
- `github.ts`: Sign in with GitHub, optional, GETs under `/auth/github/` routed by `src/server.ts`.
  The owner creates a private GitHub App from `manifest(base)` (name `crashyard <host>`, at most 34 characters;
  `redirect_url` `/auth/github/created`, `callback_urls` `/auth/github/callback`, permission `emails: read` only, no
  webhook), posted from Settings, People to `github.com/settings/apps/new` or an organization's (`startApp`, a
  `github-app` state of an hour). `created` (owners only) trades the code at `app-manifests/<code>/conversions` for
  the app's id, slug, client id and secret, kept in `settings` as `auth.github` (`GitHubApp`). `start` sets a state
  (`github`, ten minutes, the PKCE verifier as its challenge, `next` through `nextPath` and an invite) and binds it to the browser with
  the `crashyard_github` cookie (`Path=/auth/github`); `callback` takes it only when the cookie matches, trades the
  code with the verifier, reads `/user` and `/user/emails`, then signs in, in order: the account linked before
  (`users.github_id`), someone here by any verified email (linking the account, unless theirs is another), or with an
  invite its role (only the email it names, if it names one; one use), else `/signin?error=github-unknown`. GitHub
  says who someone is; crashyard decides who comes in. Errors go back to `/signin` or the invite as `?error=`.
  Membership of an organization as a way in is left out: it needs the app installed on the organization with
  members read.
- Agent tokens (`cyp_`, `user_tokens`): only on `/mcp`, as `Authorization: Bearer`; checked in
  `src/server.ts` before the session, acting as their person with `tokenRole` (read: viewer; change: at most member),
  `last_used_at` at most once a minute. Removing the person deletes them.
- `sign-in.test.ts` on `test/fakes.ts`: dev, sessions (unknown, expired, a removed person, renewal and
  the cookie's flags), `/auth`'s Origin check, setup's code and once only, challenges once and for five minutes,
  invites once and expiry, recovery codes once, signing out, the last owner, the last way in, role order, passkey
  names, and the role of every changing server function. The ceremonies
  themselves were driven in Chrome with a CDP virtual authenticator (setup, sign out, sign in, invite).
  `github.test.ts` with GitHub stubbed: the manifest, keeping the app (owners, its own state), PKCE, by email then by
  account, an unverified email, another browser's callback, invites (the named email, once).
