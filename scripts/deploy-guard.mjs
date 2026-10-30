// Part of `pnpm run deploy`, after the build: creates the D1 database on a first deploy, since migrations run before
// `wrangler deploy` could make it, then stops a deploy of an older crashyard than the one the dashboard installed
// (src/update/install.ts keeps it as `update.installed`), which would undo that update. A database without it, as on a
// first deploy, goes ahead.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const wrangler = (args) =>
  execFileSync('pnpm', ['exec', 'wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

// The built config, so a renamed database or one given by id is respected
const db = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8')).d1_databases[0]
if (!db.database_id) {
  try {
    wrangler(['d1', 'info', db.database_name, '--json'])
  } catch {
    console.log(`Creating the D1 database ${db.database_name}.`)
    // `wrangler deploy` connects the binding to it by name
    wrangler(['d1', 'create', db.database_name, '--update-config=false'])
  }
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const parts = (v) => v.split(/[.-]/).map(Number)
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

let installed
try {
  const out = wrangler([
    'd1',
    'execute',
    'DB',
    '--remote',
    '--json',
    '--command',
    "SELECT value FROM settings WHERE key = 'update.installed'",
  ])
  installed = JSON.parse(JSON.parse(out)[0].results[0]?.value ?? 'null')?.version
} catch {
  // No settings table yet, or no answer: nothing to compare with
}
if (installed && newer(installed, version)) {
  console.error(
    `crashyard ${installed} was installed from the dashboard, and this checkout is ${version}. ` +
      `Deploying it would go back to ${version}. Bring the checkout up to ${installed} first, with git pull, then deploy.`,
  )
  process.exit(1)
}
