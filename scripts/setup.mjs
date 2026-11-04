// Sets up a deployment from a clone (docs/deploying.md): asks for its domain and email sender, writes them to
// wrangler.local.json (git-ignored), then offers to deploy, makes the setup code for the first owner's passkey and
// adds the R2 cleanup rules.
// Run again to change a value: what's there is the default. Needs `pnpm wrangler login` first.
//   pnpm run setup
import { execFileSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
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
  // The dashboard's route comes first; the rest, such as status pages' own domains, stay
  local.routes = [{ pattern: host, custom_domain: true }, ...(local.routes ?? []).slice(1)]
  local.workers_dev = false
  vars.PUBLIC_URL = `https://${host}`
}
vars.EMAIL_FROM = await ask(
  'Email notifications from (an address on a domain with Email Routing; empty: none)',
  vars.EMAIL_FROM,
)
local.vars = Object.fromEntries(Object.entries(vars).filter(([, v]) => v))
writeFileSync(file, `${JSON.stringify(local, null, 2)}\n`)
console.log(`Wrote ${file}.`)

if (await yes('Deploy now (build, migrate the D1 database, deploy)?')) {
  run(['run', 'deploy'])
  // A secret, so no file or deploy holds it. Readable: no 0, O, 1, I or L. It only works at /setup while there's
  // no one, so it's harmless once used
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const group = () => Array.from({ length: 5 }, () => letters[randomInt(letters.length)]).join('')
  const code = [group(), group(), group()].join('-')
  run(['-s', 'wrangler', 'secret', 'put', 'SETUP_CODE'], code)
  console.log(
    `\nOpen ${vars.PUBLIC_URL ?? 'your crashyard'}/setup and enter the setup code ${code} to create your owner passkey.\n`,
  )
  if (await yes('Have R2 delete failed envelopes after 30 days, and unfinished uploads after one?')) {
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
      'failed',
      'failed/',
      '--expire-days',
      '30',
      '--force',
    ])
  }
}
rl.close()
