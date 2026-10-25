# Docs

What people deploying or contributing read. Plain Markdown, true to the code: a change that makes a page wrong
updates it in the same commit.

- `deploying.md`: a fresh Cloudflare account to a running crashyard, Access included. Keep it true to `wrangler.jsonc` (and `wrangler.local.json`, its overlay),
  `src/server.ts` and `src/auth/`: someone deploying follows it to the letter.
- `mcp.md`: the MCP server, and letting an agent in with an Access service token.
- `linking.md`: linking an app, per platform. The same snippets are in `src/components/linking.tsx`: keep them in step.
- `decisions/`: one short file per big choice (`NNNN-title.md`): the context, the decision, what it costs. Add one for
  any choice a contributor might otherwise argue against.
