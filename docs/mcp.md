# The MCP server

crashyard runs an MCP server over Streamable HTTP at `/mcp`. An agent such as Claude Code can use it to investigate a
crash from your terminal, check a release or a slow endpoint, and triage what it finds.

To read, an agent can use these tools:

- `list_projects`: the projects and their slugs, with unresolved issues, events in the last 24 hours and the newest
  release.
- `search_issues` and `get_issue`: issues by Sentry's search syntax, and one issue with its events per day, top tags,
  stack trace, breadcrumbs, contexts, notes and suspect commits.
- `list_issue_events`: an issue's events, with any tags as columns, to pick one for `get_issue`.
- `search_events`: events or users counted across issues, grouped by release, environment, level, project or any tag.
- `get_trace`: one trace's transactions with their spans, its errors and its logs.
- `search_logs`: logs by search, including by trace.
- `list_releases` and `get_release`: releases with crash-free sessions and adoption, and one release with its deploys,
  commits and its issues against the release before.
- `list_transactions` and `get_transaction`: transactions by p95, and one with its releases and slowest examples.
- `list_monitors` and `get_monitor`: cron monitors and uptime checks, and one with its results, incidents and errors.
- `list_status_pages`: the status pages with their checks and posts.

To change things, an agent can use these tools:

- `resolve_issue`, `ignore_issue` and `reopen_issue`, for one issue or several. Resolving can name the release with
  the fix.
- `set_priority`, `assign_issue`, `merge_issues`, `link_issue` and `add_note`.
- `post_status_update`: opens an incident, a notice or maintenance on a status page, or adds an update to one. A
  status page is public, so whatever the agent writes there, anyone can read.

Settings, notifications, monitors, people and tokens stay out of an agent's reach.

## Give an agent access

An agent can't sign in through a browser, so it uses an agent token.

1. Open Settings, then **Agent tokens**, and choose **Create token**. Name it after the agent, choose whether it can
   only read or also change things, and when it expires.
2. Copy the token. It's shown only once, with the command to add it to Claude Code:

   ```sh
   claude mcp add --transport http crashyard https://crashyard.example.com/mcp \
     --header "Authorization: Bearer cyp_…"
   ```

The token acts as you. Every change it makes appears in the issue's activity under your email, and it can never do
more than your role allows. A token that can only read can't use any tool that changes things. Delete it on the same page
to lock it out. Removing someone deletes their tokens too.

## Run it locally

`pnpm dev` signs everyone in as `dev@localhost`, so `http://localhost:3000/mcp` answers anyone on your machine.

```sh
curl -s localhost:3000/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_issues","arguments":{}}}'
```
