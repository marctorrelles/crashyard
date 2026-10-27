// The worker's secrets, which `wrangler types` can't see: set with `wrangler secret put` or in the dashboard
// (docs/deploying.md), and on a dev server from the shell (`SETUP_CODE=… pnpm dev`, vite.config.ts)
declare namespace Cloudflare {
  interface Env {
    /** Creates the first owner at /setup, while there's no one yet */
    SETUP_CODE?: string
  }
}
interface Env {
  SETUP_CODE?: string
}
