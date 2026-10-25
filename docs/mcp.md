# The MCP server

crashyard answers MCP (Streamable HTTP) at `/mcp`, so an agent such as Claude Code can look into a crash from your
terminal: search issues, read one with its stack, breadcrumbs and contexts, search logs (by trace too), and resolve,
ignore or note an issue. Every change it makes is written to the issue's activity, as `service:<token id>`.

Tools: `search_issues`, `get_issue`, `search_logs`, `resolve_issue`, `ignore_issue`, `add_note`.

## Let an agent in

`/mcp` sits behind Cloudflare Access like the dashboard. An agent can't sign in through a browser, so it uses an
Access service token.

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → Access → Service credentials → Service Tokens →
   **Create Service Token**. Name it (`claude`), pick a duration, and copy the **Client ID** and **Client Secret**
   (the secret is shown once).
2. Access → Applications → the `crashyard` application → Policies → **Add a policy**: action **Service Auth**,
   Include → **Service Token** → the token you made. Save. (Your Allow policy for people stays as it is.)
3. Add the server to Claude Code:

   ```sh
   claude mcp add --transport http crashyard https://crashyard.example.com/mcp \
     --header "CF-Access-Client-Id: <client id>" \
     --header "CF-Access-Client-Secret: <client secret>"
   ```

The token gets in wherever a person would: every project, and the dashboard too. Revoke it in the same place to
lock it out.

## Locally

`pnpm dev` has no Access in front: `http://localhost:3000/mcp` answers anyone on your machine.

```sh
curl -s localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_issues","arguments":{}}}'
```
