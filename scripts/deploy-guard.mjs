// Part of `pnpm run deploy`, after the build: stops a deploy of an older crashyard than the one the dashboard installed
// (src/update/install.ts keeps it as `update.installed`), which would undo that update. A database without it, as on a
// first deploy, goes ahead.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const parts = (v) => v.split(/[.-]/).map(Number)
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

let installed
try {
  const out = execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--remote',
      '--json',
      '--command',
      "SELECT value FROM settings WHERE key = 'update.installed'",
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
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
