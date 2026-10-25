# Auth

Who's signed in to the dashboard. Cloudflare Access does the signing in; this checks its token.

- `access.ts`: `viewerOf(request, env, dev)` verifies `Cf-Access-Jwt-Assertion` against the team's keys
  (`https://<team>/cdn-cgi/access/certs`, cached per isolate) with the issuer and the application's audience
  (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` in `wrangler.jsonc`), and returns the email in it.
- **Fail closed:** a local dev server (`import.meta.env.DEV`, false in every build) lets everyone in as
  `dev@localhost`; a deployment without Access configured refuses everyone.
- `src/server.ts` calls it for every path but `/api/*` and passes the email on as `x-crashyard-viewer`, replacing any
  such header sent from outside. Server code reads who's signed in from that header only.
- A service token (an agent on `/mcp`) has no email: it's named `service:<common_name>`.
- No users, members or roles of our own: who may sign in is Access's policy.
- `access.test.ts`: the fail-closed rules.
