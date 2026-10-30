// A one-time recovery code for someone who lost every passkey and recovery code (docs/deploying.md): it goes into the
// deployment's database through wrangler, so only someone with the Cloudflare account can make one. They sign in at
// /signin, Use a recovery code, with their email and this code, then add a passkey.
//   pnpm run recovery-code you@example.com            (--local for the dev database)
import { execFileSync } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'

const email = process.argv[2]?.trim().toLowerCase()
const where = process.argv.includes('--local') ? '--local' : '--remote'
if (!email || !/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) {
  console.error('Give the email of the person to recover: pnpm run recovery-code you@example.com')
  process.exit(1)
}
// As src/data/people.ts makes and stores them: readable groups, the SHA-256 of the code without its dash
const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const group = () => Array.from({ length: 5 }, () => letters[randomInt(letters.length)]).join('')
const code = `${group()}-${group()}`
const hash = createHash('sha256').update(code.replace('-', '')).digest('hex')
const sql = `INSERT INTO recovery_codes (user_id, hash) SELECT id, '${hash}' FROM users WHERE email = '${email}' RETURNING user_id`
// The deployment's database is the one in the built config, with wrangler.local.json laid over it: d1 commands
// otherwise read wrangler.jsonc alone, and a database renamed there would be missed. The dev database is wrangler.jsonc's
const CONFIG = 'dist/server/wrangler.json'
if (where === '--remote' && !existsSync(CONFIG)) execFileSync('pnpm', ['-s', 'build'], { stdio: 'inherit' })
const config = where === '--remote' ? ['-c', CONFIG] : []
let out
try {
  out = execFileSync('pnpm', ['-s', 'wrangler', 'd1', 'execute', 'DB', where, ...config, '--json', '--command', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  const said = /"text":\s*"([^"]+)"/.exec(String(error.stdout))?.[1]
  console.error(
    `The database couldn't be reached${said ? `: ${said}` : ''}. Check that pnpm wrangler login is done and crashyard is deployed.`,
  )
  process.exit(1)
}
if (!JSON.parse(out)[0]?.results?.length) {
  console.error(`No one signs in with ${email} on this crashyard. Check the email in Settings, People.`)
  process.exit(1)
}
console.log(`Recovery code for ${email}: ${code}\nIt works once, at /signin, Use a recovery code.`)
