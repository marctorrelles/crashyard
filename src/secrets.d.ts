// The worker's secrets, and the bindings only wrangler.local.json adds, which `wrangler types` can't see. Secrets: set with `wrangler secret put` or in the dashboard
// (docs/deploying.md), and on a dev server from the shell (`SETUP_CODE=… pnpm dev`, vite.config.ts)
declare namespace Cloudflare {
  interface Env {
    /** Creates the first owner at /setup, while there's no one yet */
    SETUP_CODE?: string
    /** The SymCache builder's container (src/symbols/builder.ts), where wrangler.local.json adds it */
    SYMCACHE_BUILDER?: DurableObjectNamespace
  }
}
interface Env {
  SETUP_CODE?: string
  SYMCACHE_BUILDER?: DurableObjectNamespace
}
