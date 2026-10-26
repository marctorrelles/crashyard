# The MCP server

crashyard runs an MCP server over Streamable HTTP at `/mcp`. An agent such as Claude Code can use it to investigate a
crash from your terminal. It can search issues, read one with its stack trace, breadcrumbs and contexts, search logs,
including by trace, and resolve, ignore or add a note to an issue. Every change it makes appears in the issue's
activity as `service:<token id>`.

The tools are `search_issues`, `get_issue`, `search_logs`, `resolve_issue`, `ignore_issue` and `add_note`.

## Give an agent access

`/mcp` sits behind Cloudflare Access, like the dashboard. An agent can't sign in through a browser, so it uses an
Access service token.

1. In [one.dash.cloudflare.com](https://one.dash.cloudflare.com), go to Access, then Service credentials, then
   Service Tokens, and choose **Create Service Token**. Name it, for example `claude`, and choose how long it lasts.
   Copy the **Client ID** and the **Client Secret**. The secret is shown only once.
2. Go to Access, then Applications, open the `crashyard` application, then Policies, and choose **Add a policy**. Set
   the action to **Service Auth**, and under Include choose **Service Token** and the token you created. Save. Your
   Allow policy for people stays as it is.
3. Add the server to Claude Code:

   ```sh
   claude mcp add --transport http crashyard https://crashyard.example.com/mcp \
     --header "CF-Access-Client-Id: <client id>" \
     --header "CF-Access-Client-Secret: <client secret>"
   ```

The token can reach everything a person can, including every project and the dashboard. To lock it out, revoke it on
the same page.

## Run it locally

`pnpm dev` runs without Access, so `http://localhost:3000/mcp` answers anyone on your machine.

```sh
curl -s localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_issues","arguments":{}}}'
```
