// Copies Sentry's grouping test events and what Sentry groups each by into test/fixtures/sentry-grouping, for
// src/ingest/grouping.test.ts. Run with a checkout of getsentry/sentry at 24.10.0 (Apache-2.0 since 2026-10-15):
//   node scripts/sentry-grouping-fixtures.mjs <sentry checkout>
// `expected.json`: each event's winning variant (app, else system, else the others) and its contributing values in
// order, read from tests/sentry/grouping/snapshots/test_variants/test_event_hash_variant/newstyle@2023_01_11.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sentry = process.argv[2]
if (!sentry) throw new Error('usage: node scripts/sentry-grouping-fixtures.mjs <sentry checkout at 24.10.0>')
const inputs = join(sentry, 'tests/sentry/grouping/grouping_inputs')
const snapshots = join(
  sentry,
  'tests/sentry/grouping/snapshots/test_variants/test_event_hash_variant/newstyle@2023_01_11',
)
const out = 'test/fixtures/sentry-grouping'
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'events'), { recursive: true })

/** A variant's contributing values: the value lines whose components, all the way up, are marked `*` */
function contributing(lines) {
  const values = []
  const stack = [] // [indent, contributes]
  for (const line of lines) {
    const indent = line.search(/\S/)
    const text = line.trim()
    while (stack.length && stack.at(-1)[0] >= indent) stack.pop()
    if (/^("|-?\d|null$|true$|false$)/.test(text)) {
      if (stack.every(([, on]) => on)) values.push(JSON.parse(text))
      continue
    }
    stack.push([indent, /^[\w-]+\*/.test(text)])
  }
  return values
}

const expected = {}
for (const file of readdirSync(inputs)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const id = file.slice(0, -5).replaceAll('-', '_')
  let snap
  try {
    snap = readFileSync(join(snapshots, `${id}.pysnap`), 'utf8')
  } catch {
    continue
  }
  const variants = {}
  for (const block of snap.split(/^-{20,}$/m)) {
    const m = block.match(/^([\w-]+):\n {2}hash: (null|"[0-9a-f]+")\n {2}component:\n([\s\S]*)/m)
    if (m) variants[m[1]] = { hash: JSON.parse(m[2]), lines: m[3].split('\n').filter((l) => l.trim()) }
  }
  const order = ['app', 'system', ...Object.keys(variants).filter((v) => v !== 'app' && v !== 'system')]
  const winner = order.find((v) => variants[v]?.hash)
  if (!winner) continue
  cpSync(join(inputs, file), join(out, 'events', file))
  expected[file] = { variant: winner, values: contributing(variants[winner].lines.slice(1)) }
}
writeFileSync(join(out, 'expected.json'), `${JSON.stringify(expected, null, 1)}\n`)
console.log(`${Object.keys(expected).length} events`)
