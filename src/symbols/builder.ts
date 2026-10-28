// The SymCache builder: a Cloudflare Container (symcache/Dockerfile, src/bin/builder.rs) behind a Durable Object, for
// debug files too big to convert in a Worker's 128 MB. Optional: a deployment has it when wrangler.local.json binds
// SYMCACHE_BUILDER (docs/deploying.md); without it, debug files stop at MAX_FILE.
import { DurableObject } from 'cloudflare:workers'

const PORT = 8080
// How long it takes the container to listen after a cold start, at most
const START_TRIES = 60

export class SymcacheBuilder extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container
    if (!container)
      return Response.json(
        { error: 'The SymCache builder’s container isn’t running here. A dev server runs it with CONTAINERS=1.' },
        { status: 503 },
      )
    if (!container.running) {
      container.start()
      // Stopped a minute after its last request: an upload is a few requests in a row, then nothing for days
      await container.setInactivityTimeout(60_000)
    }
    const port = container.getTcpPort(PORT)
    for (let i = 0; ; i++) {
      try {
        if ((await port.fetch('http://builder/health')).ok) break
      } catch (error) {
        if (i >= START_TRIES) throw error
      }
      await scheduler.wait(500)
    }
    const url = new URL(request.url)
    return port.fetch(`http://builder${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
  }
}
