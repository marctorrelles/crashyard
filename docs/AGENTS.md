# Docs

What people deploying or contributing read. Plain Markdown, true to the code: a change that makes a page wrong
updates it in the same commit.

- `deploying.md` (and the README, which says it too): native crashes and source maps need Workers Paid, as
  symbolication takes more CPU than the free plan's 10 ms a request (`src/symbols/AGENTS.md`).
- `deploying.md`: a fresh Cloudflare account to a running crashyard, Access included. Keep it true to `wrangler.jsonc` (and `wrangler.local.json`, its overlay),
  `src/server.ts` and `src/auth/`: someone deploying follows it to the letter.
- `mcp.md`: the MCP server, and letting an agent in with an Access service token.
- `linking.md`: linking an app, per platform. The same snippets are in `src/components/linking.tsx`: keep them in step.
- `sentry-compatibility.md`: what of Sentry's SDKs, envelope items, API and CLI works, is partial or ignored, and
  against which versions it was checked. A change to ingest or `src/api/sentry.ts` updates it.
- `architecture.md`: the worker, D1, R2, the cron and the ingest paths, as one diagram (Mermaid) and a line each.
- `upgrading.md`: pulling a release into a clone or a button deployment, and rolling back.
- `images/`: the README's pictures (`pnpm seed`, then the issues list at 1280 × 800, 2×, light and dark, as JPEG).
- `decisions/`: one short file per big choice (`NNNN-title.md`): the context, the decision, what it costs. Add one for
  any choice a contributor might otherwise argue against.
