# Auth

Who's signed in to the dashboard, in one of two modes (`mode.ts`, `authMode`): `AUTH` in `vars` when it says
`crashyard` or `access`, else Access when `ACCESS_AUD` is set (a deployment from before keeps working), else crashyard's
own sign-in. Decision: `docs/decisions/0005-own-sign-in.md`.

- `session.ts`: `whoIs(request, env, mode, dev, now)`, the one answer `src/server.ts` acts on: `{ email, role, userId?,
session?, cookie? }` or null. A dev server (`import.meta.env.DEV`, false in every build) is `dev@localhost`, an owner,
  unless `AUTH` is `crashyard` (`AUTH=crashyard SETUP_CODE=… pnpm dev`, `vite.config.ts` passes both). Access: its
  token's email as an owner, a service token (`service:<common_name>`) as a viewer. crashyard: the `crashyard_session`
  cookie (HttpOnly, SameSite=Lax so a link from elsewhere opens signed in, Secure on https, 90 days), looked up by its
  SHA-256 (`src/data/people.ts`); renewed when under 60 days are left, at most once a day, so reading pages rarely
  writes; `cookie` is then the Set-Cookie to send.
- `access.ts`: `viewerOf(request, env, dev)` verifies `Cf-Access-Jwt-Assertion` against the team's keys
  (`https://<team>/cdn-cgi/access/certs`, cached per isolate) with the issuer and the application's audience
  (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`), and returns the email in it.
- `passkeys.ts`: `handleAuth(path, ctx)`, `/auth/*`, plain JSON POSTs ahead of Start, refused unless `Origin` is the
  request's own. Each ceremony is `<kind>/options` (a challenge in `challenges`, five minutes, one use: `takeChallenge`
  deletes it) then `<kind>/verify` (`@simplewebauthn/server`; resident keys required, user verification preferred,
  attestation none). `setup` (only while there's no one, with `SETUP_CODE` compared as digests of the code without
  dashes or spaces; the first owner, signed in, ten recovery codes), `claim` (Access mode, no one yet: the person Access
  let in becomes the owner, for moving over; their Access session stays), `signin` (any of this crashyard's passkeys,
  picked by the browser: no email to type; the counter written back), `passkeys` (another for whoever is signed in,
  their others excluded), `invite` (the invite taken first, `useInvite` only while unused and unexpired, so one use
  even from two tabs, then the person with its role; an email it names is the only one it takes), `recover` (email and
  a recovery code, once per code) and `signout` (a form POST: the session deleted, the cookie cleared, 303 to
  `/signin`). The relying party is `PUBLIC_URL`'s host (not on a dev server), else the request's: a domain change means
  new passkeys. The authenticator's user handle is SHA-256 of `crashyard:<email>`, so a device keeps one per person.
- **Fail closed:** crashyard mode with no session opens only `/signin`, `/setup` and `/invite/<token>` (pages redirect
  there: `/setup` while there's no one, else `/signin?next=`; server functions, `/mcp` and other methods get 401);
  signed in, those three redirect to `/`. Access mode without Access configured refuses everyone (403), as before.
- `src/server.ts` passes who's asking on as headers, after dropping every `x-crashyard-*` sent from outside:
  `x-crashyard-viewer` (the email: activity, assignees, preferences and bookmarks are by email in both modes),
  `x-crashyard-role`, `x-crashyard-user` and `x-crashyard-session` (crashyard mode) and `x-crashyard-auth` (the
  mode). Server code reads them only there.
- Roles (`src/data/people.ts`, `ROLES`, `reaches`): owner (everything, People; at least one always), admin (projects,
  keys, channels, routes, alerts, monitors, upload tokens, debug files, defaults, privacy, the agents switch, test
  sends), member (resolve, ignore, assign, merge, link, notes, dashboards), viewer (reads, their own preferences,
  bookmarks, saved searches and sign-in). Every POST server function in `src/fns.ts` names its least role,
  `.middleware([signedIn | member | admin | owner])`; `sign-in.test.ts` fails on one that doesn't. In Access mode
  everyone is an owner (Access's policy says who comes in).
- Agent tokens (`cyp_`, `user_tokens`): only on `/mcp`, only in crashyard mode, as `Authorization: Bearer`; checked in
  `src/server.ts` before the session, acting as their person with `tokenRole` (read: viewer; change: at most member),
  `last_used_at` at most once a minute. Removing the person deletes them.
- `sign-in.test.ts` on `test/fakes.ts`: the mode rule, dev, sessions (unknown, expired, a removed person, renewal and
  the cookie's flags), `/auth`'s Origin check, setup's code and once only, challenges once and for five minutes,
  invites once and expiry, recovery codes once, signing out, the last owner, the last way in, role order, passkey
  names, and the role of every changing server function. `access.test.ts`: Access's fail-closed rules. The ceremonies
  themselves were driven in Chrome with a CDP virtual authenticator (setup, sign out, sign in, invite).
