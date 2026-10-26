// Sets up a deployment from a clone (docs/deploying.md): asks for its domain and Access values, writes them to
// wrangler.local.json (git-ignored), then offers to deploy and add the R2 cleanup rules.
// Run again to change a value: what's there is the default. Needs `pnpm wrangler login` first.
//   pnpm run setup
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'

const file = 'wrangler.local.json'
const local = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
const vars = local.vars ?? {}
// Lines read as they come, so answers piped in all arrive (rl.question drops those sent before it asks)
const rl = createInterface({ input: process.stdin })
const lines = rl[Symbol.asyncIterator]()
const line = async (prompt) => (process.stdout.write(prompt), ((await lines.next()).value ?? '').trim())
const ask = async (question, now = '') => (await line(`${question}${now ? ` [${now}]` : ''}: `)) || now
const yes = async (question) => !/^n/i.test(await line(`${question} (Y/n) `))
const run = (args, input) =>
  execFileSync('pnpm', args, { stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'], input })

const host = await ask(
  'The dashboard’s subdomain, on a domain in your Cloudflare account (empty: workers.dev)',
  local.routes?.[0]?.pattern,
)
if (host) {
  local.routes = [{ pattern: host, custom_domain: true }]
  local.workers_dev = false
  vars.PUBLIC_URL = `https://${host}`
}
console.log('Cloudflare Access (docs/deploying.md, step 3): leave empty until you have them, and run this again.')
vars.ACCESS_TEAM_DOMAIN = await ask('Team domain (<team>.cloudflareaccess.com)', vars.ACCESS_TEAM_DOMAIN)
vars.ACCESS_AUD = await ask('The crashyard application’s audience (AUD) tag', vars.ACCESS_AUD)
vars.EMAIL_FROM = await ask(
  'Email notifications from (an address on a domain with Email Routing; empty: none)',
  vars.EMAIL_FROM,
)
local.vars = Object.fromEntries(Object.entries(vars).filter(([, v]) => v))
writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`)
console.log(`Wrote ${file}.`)

if (await yes('Deploy now (build, migrate the D1 database, deploy)?')) {
  run(['run', 'deploy'])
  if (await yes('Have R2 delete raw envelopes after 30 days, attachments after 90 and unfinished uploads after one?')) {
    run([
      'wrangler',
      'r2',
      'bucket',
      'lifecycle',
      'add',
      'crashyard-files',
      'envelopes',
      'envelopes/',
      '--expire-days',
      '30',
      '--force',
    ])
    run([
      'wrangler',
      'r2',
      'bucket',
      'lifecycle',
      'add',
      'crashyard-files',
      'chunks',
      'chunks/',
      '--expire-days',
      '1',
      '--force',
    ])
    run([
      'wrangler',
      'r2',
      'bucket',
      'lifecycle',
      'add',
      'crashyard-files',
      'attachments',
      'attachments/',
      '--expire-days',
      '90',
      '--force',
    ])
  }
}
rl.close()
