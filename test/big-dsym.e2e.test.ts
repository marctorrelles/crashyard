// A debug file over the worker's limits, through the SymCache builder's container: sentry-cli uploads it to `vite dev`
// with the container on, then a crash naming it is symbolicated as the same SymCache, made here, reads it. Opt-in, as
// it needs Docker and a real dSYM of tens of MB, so `pnpm test` stays fast:
//   BIG_DSYM=path/to/App.app.dSYM CONTAINERS=1 pnpm vitest run test/big-dsym.e2e.test.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createToken } from '../src/data/tokens'
import { symbolic } from '../src/symbols/symcache'
import { MAX_FILE } from '../src/symbols/uploads'
import { KEY, startDev, waitFor } from './dev'

const DSYM = process.env.BIG_DSYM
const PORT = 3996
let dev: Awaited<ReturnType<typeof startDev>>

describe.skipIf(!DSYM || process.env.CONTAINERS !== '1')('a debug file over 48 MB', () => {
  beforeAll(async () => {
    dev = await startDev(PORT, '.wrangler/e2e-big')
  }, 600_000)
  afterAll(() => dev?.stop())

  it('uploads through the builder and symbolicates', async () => {
    const dwarfDir = join(DSYM!, 'Contents/Resources/DWARF')
    const dwarf = join(dwarfDir, readdirSync(dwarfDir)[0])
    expect(statSync(dwarf).size).toBeGreaterThan(MAX_FILE)

    // What the address should read as: the same SymCache, made here by the Wasm module (Node has no 128 MB cap)
    const s = await symbolic(await WebAssembly.compile(readFileSync('src/symbols/symcache.wasm')))
    const file = new Uint8Array(readFileSync(dwarf))
    const [object] = s.objects(file)
    const cache = s.symcache(file, object.debugId)
    const loaded = await s.load(cache.length, new Blob([cache.slice()]).stream())
    const candidates = Array.from({ length: 256 }, (_, i) => BigInt(0x4000 + i * 0x1000))
    const found = s.lookup(loaded, candidates)
    const at = found.findIndex((frames) => frames.length > 0)
    expect(at).toBeGreaterThanOrEqual(0)
    const expected = found[at][0]

    const token = await createToken(dev.db, 'e2e', 'test', Date.now())
    // Not execFileSync: a blocked event loop leaves fetch a keep-alive socket the server has closed meanwhile
    const { stdout: out } = await promisify(execFile)(
      'pnpm',
      ['exec', 'sentry-cli', 'debug-files', 'upload', '--wait', DSYM!],
      {
        env: {
          ...process.env,
          SENTRY_URL: dev.origin,
          SENTRY_AUTH_TOKEN: token,
          SENTRY_ORG: 'crashyard',
          SENTRY_PROJECT: 'e2e',
        },
      },
    )
    expect(out).not.toMatch(/error/i)
    const row = await dev.db.prepare('SELECT * FROM debug_files WHERE debug_id = ?').bind(object.debugId).first()
    expect(row).toMatchObject({ kind: 'macho', size: file.length })

    const eventId = crypto.randomUUID().replace(/-/g, '')
    const base = 0x100000000n
    const event = {
      event_id: eventId,
      platform: 'cocoa',
      level: 'fatal',
      exception: {
        values: [
          {
            type: 'EXC_BAD_ACCESS',
            mechanism: { type: 'mach', handled: false },
            stacktrace: { frames: [{ instruction_addr: `0x${(base + candidates[at]).toString(16)}`, in_app: true }] },
          },
        ],
      },
      debug_meta: {
        images: [
          { type: 'macho', debug_id: object.debugId, image_addr: `0x${base.toString(16)}`, image_size: 1 << 30 },
        ],
      },
    }
    await fetch(`${dev.origin}/api/1/envelope/?sentry_key=${KEY}`, {
      method: 'POST',
      body: `${JSON.stringify({ event_id: eventId })}\n{"type":"event"}\n${JSON.stringify(event)}\n`,
    })
    const data = await waitFor(
      () => dev.db.prepare('SELECT data FROM events WHERE id = ?').bind(eventId).first<{ data: string }>(),
      30_000,
    )
    const frames = JSON.parse(data.data).exceptions[0].frames as Record<string, unknown>[]
    expect(frames.at(-1)).toMatchObject({ function: expected.function })
  }, 600_000)
})
