// Readable stacks, with the real sentry-cli uploading to `vite dev`: a dSYM (after a crash that needed it, so the
// issue is re-symbolicated and regrouped), a minified bundle with its source map, and a ProGuard mapping.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createToken } from '../src/data/tokens'
import { symbolic } from '../src/symbols/symcache'
import { KEY, startDev, waitFor } from './dev'

const PORT = 3997
let dev: Awaited<ReturnType<typeof startDev>>
let token: string

const id = () => crypto.randomUUID().replace(/-/g, '')
const send = (event: Record<string, unknown>) =>
  fetch(`${dev.origin}/api/1/envelope/?sentry_key=${KEY}`, {
    method: 'POST',
    body: `${JSON.stringify({ event_id: event.event_id })}\n{"type":"event"}\n${JSON.stringify(event)}\n`,
  })
const cli = (...args: string[]) =>
  execFileSync('pnpm', ['exec', 'sentry-cli', ...args], {
    env: {
      ...process.env,
      SENTRY_URL: dev.origin,
      SENTRY_AUTH_TOKEN: token,
      SENTRY_ORG: 'crashyard',
      SENTRY_PROJECT: 'e2e',
    },
    stdio: 'pipe',
  }).toString()
const issueOf = async (eventId: string) =>
  dev.db
    .prepare('SELECT i.* FROM issues i JOIN events e ON e.issue_id = i.id WHERE e.id = ?')
    .bind(eventId)
    .first<Record<string, unknown>>()
const framesOf = async (eventId: string) =>
  JSON.parse(
    (await dev.db.prepare('SELECT data FROM events WHERE id = ?').bind(eventId).first<{ data: string }>())!.data,
  ).exceptions[0].frames as Record<string, unknown>[]

beforeAll(async () => {
  dev = await startDev(PORT, '.wrangler/e2e-uploads')
  token = await createToken(dev.db, 'e2e', 'test', Date.now())
}, 60_000)
afterAll(() => dev?.stop())

const DSYM = 'test/fixtures/native/crash.dSYM'
const DWARF = `${DSYM}/Contents/Resources/DWARF/crash`

describe('readable stacks, uploaded with sentry-cli', () => {
  it('symbolicates a native crash once its dSYM arrives, and regroups it', async () => {
    const s = await symbolic(await WebAssembly.compile(readFileSync('src/symbols/symcache.wasm')))
    const [object] = s.objects(new Uint8Array(readFileSync(DWARF)))
    const crash = () => ({
      event_id: id(),
      platform: 'cocoa',
      level: 'fatal',
      release: 'crash@1.0',
      exception: {
        values: [
          {
            type: 'EXC_BAD_ACCESS',
            value: 'KERN_INVALID_ADDRESS at 0x0',
            mechanism: { type: 'mach', handled: false },
            // main (crash.c:9) called render_voice, which crashed at crash.c:5; loaded at 0x104000000
            stacktrace: {
              frames: [
                { instruction_addr: '0x104000499', in_app: true },
                { instruction_addr: '0x104000468', in_app: true },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'macho',
            debug_id: object.debugId.toUpperCase(),
            image_addr: '0x104000000',
            image_size: 16384,
            code_file: '/private/var/containers/Bundle/Application/X/crash.app/crash',
          },
        ],
      },
    })
    const before = crash()
    await send(before)
    const unreadable = await waitFor(() => issueOf(before.event_id))
    expect(unreadable.culprit).not.toBe('render_voice')

    expect(cli('debug-files', 'upload', '--wait', DSYM)).toMatch(/crash/)
    const row = await dev.db.prepare('SELECT * FROM debug_files WHERE debug_id = ?').bind(object.debugId).first()
    expect(row).toMatchObject({ kind: 'macho', arch: 'arm64' })

    // The waiting event is mapped again, and its issue takes the stack's new fingerprint
    await waitFor(async () => (await issueOf(before.event_id))?.culprit === 'render_voice')
    expect(await framesOf(before.event_id)).toMatchObject([
      { function: 'main', filename: 'crash.c', lineno: 9 },
      { function: 'render_voice', filename: 'crash.c', lineno: 5 },
    ])
    const after = crash()
    await send(after)
    expect((await waitFor(() => issueOf(after.event_id))).id).toBe(unreadable.id)
  })

  it('maps a minified frame through its source map, found by debug id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crashyard-web-'))
    cpSync('test/fixtures/web', dir, { recursive: true })
    cli('sourcemaps', 'inject', dir)
    cli('sourcemaps', 'upload', dir, '--url-prefix', '~/assets')
    const map = JSON.parse(readFileSync(join(dir, 'app.min.js.map'), 'utf8'))
    const minified = readFileSync(join(dir, 'app.min.js'), 'utf8').split('\n')
    const line = minified.findIndex((l) => l.includes('t.content.blocks'))
    const url = 'https://notes.example.com/assets/app.min.js'
    const event = {
      event_id: id(),
      platform: 'javascript',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'blocks')",
            stacktrace: {
              frames: [
                {
                  filename: url,
                  abs_path: url,
                  lineno: line + 1,
                  colno: minified[line].indexOf('t.content.blocks') + 1,
                  function: 'o',
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      debug_meta: { images: [{ type: 'sourcemap', code_file: url, debug_id: map.debug_id ?? map.debugId }] },
    }
    await send(event)
    await waitFor(() => issueOf(event.event_id))
    const [frame] = await framesOf(event.event_id)
    expect(frame).toMatchObject({ filename: 'app.ts', lineno: 4, function: 'firstBlock' })
    expect((frame.context as { line: string }).line).toContain('note.content!.blocks[0]')
  })

  it('retraces an Android stack through its ProGuard mapping, inlined calls too', async () => {
    cli('upload-proguard', 'test/fixtures/proguard/mapping.txt')
    const { debug_id: uuid } = (await dev.db
      .prepare("SELECT debug_id FROM debug_files WHERE kind = 'proguard'")
      .first<{ debug_id: string }>())!
    const event = {
      event_id: id(),
      platform: 'java',
      exception: {
        values: [
          {
            type: 'IllegalStateException',
            module: 'java.lang',
            value: 'no voice',
            stacktrace: { frames: [{ module: 'a.a', function: 'a', lineno: 5, in_app: true }] },
          },
        ],
      },
      debug_meta: { images: [{ type: 'proguard', uuid }] },
    }
    await send(event)
    await waitFor(() => issueOf(event.event_id))
    expect(await framesOf(event.event_id)).toMatchObject([
      { module: 'com.example.pocketband.Player', function: 'play', lineno: 14 },
      { module: 'com.example.pocketband.Player', function: 'voiceAt', lineno: 20 },
    ])
    expect((await issueOf(event.event_id))!.culprit).toBe('com.example.pocketband.Player in voiceAt')
  })

  it('refuses uploads without a token', async () => {
    const r = await fetch(`${dev.origin}/api/0/organizations/x/chunk-upload/`)
    expect(r.status).toBe(401)
  })
})
