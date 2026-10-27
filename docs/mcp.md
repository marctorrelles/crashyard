# The MCP server

crashyard runs an MCP server over Streamable HTTP at `/mcp`. An agent such as Claude Code can use it to investigate a
crash from your terminal. It can search issues, read one with its stack trace, breadcrumbs and contexts, search logs,
including by trace, and resolve, ignore or add a note to an issue.

The tools are `search_issues`, `get_issue`, `search_logs`, `resolve_issue`, `ignore_issue` and `add_note`.

## Give an agent access

An agent can't sign in through a browser, so it uses an agent token.

1. Open Settings, then **Agent tokens**, and choose **Create token**. Name it after the agent, choose whether it can
   only read or also change issues, and when it expires.
2. Copy the token. It's shown only once, with the command to add it to Claude Code:

   ```sh
   claude mcp add --transport http crashyard https://crashyard.example.com/mcp \
     --header "Authorization: Bearer cyp_…"
   ```

The token acts as you. Every change it makes appears in the issue's activity under your email, and it can never do
more than your role allows. A token that can only read can't resolve, ignore or add notes. Delete it on the same page
to lock it out. Removing someone deletes their tokens too.

## Run it locally

`pnpm dev` signs everyone in as `dev@localhost`, so `http://localhost:3000/mcp` answers anyone on your machine.

```sh
curl -s localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_issues","arguments":{}}}'
```
