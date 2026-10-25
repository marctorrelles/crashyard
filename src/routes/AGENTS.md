# Routes

TanStack Start's file-based routes: pages, and the API under `api/`. `routeTree.gen.ts` is generated (by the dev
server, the build, or `tsr generate`): never edit it.

- `__root.tsx`: the document. Light or dark follows the system (a script sets `.dark` before paint and when the system
  changes); there's no toggle. The viewport covers the notch (`viewport-fit=cover`).
- `index.tsx`: home.
- Pages are behind Access (`src/server.ts`); routes under `api/` are not, and check the project key or auth token
  themselves.
- Data for a page comes from a server function called in the loader, not from `fetch('/api/...')`.
