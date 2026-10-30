// Before any remote command of the demo's deploy (scripts/demo/deploy.sh): stops unless the built config,
// dist/server/wrangler.json, is the demo's alone, so nothing can reach the crashyard Worker, database or bucket.
//   node scripts/demo/preflight.mjs
import { readFileSync } from 'node:fs'

const c = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'))
const problems = []
const expect = (ok, what) => ok || problems.push(what)
expect(c.name === 'crashyard-demo', `name is ${c.name}, not crashyard-demo`)
expect(
  c.d1_databases?.length === 1 &&
    c.d1_databases[0].binding === 'DB' &&
    c.d1_databases[0].database_name === 'crashyard-demo',
  `D1 is ${JSON.stringify(c.d1_databases)}, not DB on crashyard-demo alone`,
)
expect(
  c.r2_buckets?.length === 1 &&
    c.r2_buckets[0].binding === 'FILES' &&
    c.r2_buckets[0].bucket_name === 'crashyard-demo-files',
  `R2 is ${JSON.stringify(c.r2_buckets)}, not FILES on crashyard-demo-files alone`,
)
const routes = (c.routes ?? []).map((r) => `${r.pattern}${r.custom_domain ? '' : ' (not a custom domain)'}`).sort()
expect(
  JSON.stringify(routes) === JSON.stringify(['demo-status.crashyard.dev', 'demo.crashyard.dev']),
  `routes are ${JSON.stringify(routes)}, not the demo's two custom domains`,
)
expect(c.workers_dev === false, 'workers_dev is on')
expect(c.vars?.DEMO === '1', 'vars.DEMO is not "1"')
expect(c.vars?.PUBLIC_URL === 'https://demo.crashyard.dev', `PUBLIC_URL is ${c.vars?.PUBLIC_URL}`)
expect(
  !c.containers?.length && !c.durable_objects?.bindings?.length,
  'it has containers or Durable Objects, the SymCache builder',
)
if (problems.length) {
  console.error(`dist/server/wrangler.json isn't the demo's. Nothing was run.\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('dist/server/wrangler.json is the demo’s: crashyard-demo, its D1 and R2, demo.crashyard.dev.')
