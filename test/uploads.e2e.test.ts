// Readable stacks, with the real sentry-cli uploading to `vite dev`: a dSYM (after a crash that needed it, so the
// issue is re-symbolicated and regrouped), a minified bundle with its source map, and a ProGuard mapping.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
// `gitDir`: the repository set-commits reads (git2 follows GIT_DIR)
const cliIn = (gitDir: string | undefined, ...args: string[]) =>
  execFileSync('pnpm', ['exec', 'sentry-cli', ...args], {
    env: {
      ...process.env,
      SENTRY_URL: dev.origin,
      SENTRY_AUTH_TOKEN: token,
      SENTRY_ORG: 'crashyard',
      SENTRY_PROJECT: 'e2e',
      ...(gitDir && { GIT_DIR: gitDir }),
    },
    stdio: 'pipe',
  }).toString()
const cli = (...args: string[]) => cliIn(undefined, ...args)
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

  it('maps a minified frame through its source map, found by debug id, each file of a bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crashyard-web-'))
    cpSync('test/fixtures/web', dir, { recursive: true })
    // A second file, so the bundle packs two caches and one is read from past the start of the object
    mkdirSync(join(dir, 'legacy'))
    writeFileSync(join(dir, 'legacy/app.min.js'), `${readFileSync(join(dir, 'app.min.js'), 'utf8')}\n// legacy\n`)
    cpSync(join(dir, 'app.min.js.map'), join(dir, 'legacy/app.min.js.map'))
    cli('sourcemaps', 'inject', dir)
    cli('sourcemaps', 'upload', dir, '--url-prefix', '~/assets')
    for (const file of ['app.min.js', 'legacy/app.min.js']) {
      const map = JSON.parse(readFileSync(join(dir, `${file}.map`), 'utf8'))
      const minified = readFileSync(join(dir, file), 'utf8').split('\n')
      const line = minified.findIndex((l) => l.includes('t.content.blocks'))
      const url = `https://notes.example.com/assets/${file}`
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
    }
    const offsets = await dev.db.prepare('SELECT cache_offset FROM artifact_files ORDER BY cache_offset').all()
    expect(offsets.results).toEqual([{ cache_offset: 0 }, { cache_offset: expect.any(Number) }])
    expect(offsets.results[1].cache_offset).toBeGreaterThan(0)
  })

  it('retraces an Android stack through its ProGuard mapping, inlined calls, threads and classes too', async () => {
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
            type: 'b',
            module: 'a',
            value: 'no voice',
            stacktrace: { frames: [{ module: 'a.a', function: 'a', lineno: 5, in_app: true }] },
          },
        ],
      },
      threads: { values: [{ id: 2, stacktrace: { frames: [{ module: 'a.b', function: 'b', lineno: 2 }] } }] },
      debug_meta: { images: [{ type: 'proguard', uuid }] },
    }
    await send(event)
    await waitFor(() => issueOf(event.event_id))
    expect(await framesOf(event.event_id)).toMatchObject([
      { module: 'com.example.pocketband.Player', function: 'play', lineno: 14 },
      { module: 'com.example.pocketband.Player', function: 'voiceAt', lineno: 20 },
    ])
    expect((await issueOf(event.event_id))!.culprit).toBe('com.example.pocketband.Player in voiceAt')
    const data = JSON.parse(
      (await dev.db.prepare('SELECT data FROM events WHERE id = ?').bind(event.event_id).first<{ data: string }>())!
        .data,
    )
    expect(data.exceptions[0]).toMatchObject({ module: 'com.example.pocketband', type: 'Mixer' })
    expect(data.threads[0].frames).toMatchObject([
      { module: 'com.example.pocketband.Mixer', function: 'mix', lineno: 31 },
    ])
  })

  it('keeps a release’s commits, and the files they leave, from set-commits --local', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'crashyard-git-'))
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', ...args], { cwd: repo })
        .toString()
        .trim()
    const commit = (message: string, files: Record<string, string | null>) => {
      for (const [path, text] of Object.entries(files))
        if (text === null) git('rm', '-q', path)
        else {
          mkdirSync(join(repo, dirname(path)), { recursive: true })
          writeFileSync(join(repo, path), text)
          git('add', path)
        }
      git('commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q')
    commit('First', { 'apple/Studio.swift': 'a', 'old.txt': 'b' })
    const head1 = commit('Second', { 'apple/Sync.swift': 'c' })
    const inRepo = (...args: string[]) => cliIn(join(repo, '.git'), ...args)
    inRepo('releases', 'new', '-p', 'e2e', 'app@1')
    inRepo('releases', 'set-commits', 'app@1', '--local', '--initial-depth', '1000')
    const head2 = commit('Third\n\nWith a body', { 'old.txt': null, 'web/app.ts': 'd' })
    inRepo('releases', 'new', '-p', 'e2e', 'app@2')
    inRepo('releases', 'set-commits', 'app@2', '--local', '--initial-depth', '1000')

    const commits = (version: string) =>
      dev.db
        .prepare('SELECT sha, message, author FROM release_commits WHERE version = ? ORDER BY position')
        .bind(version)
        .all()
        .then((r) => r.results)
    expect(await commits('app@1')).toMatchObject([
      { sha: head1, message: 'Second', author: 'Ada' },
      { message: 'First' },
    ])
    // Only what's new since app@1's head
    expect(await commits('app@2')).toEqual([{ sha: head2, message: 'Third\n\nWith a body', author: 'Ada' }])
    const ref = await dev.db.prepare("SELECT ref FROM releases WHERE version = 'app@2'").first<{ ref: string }>()
    expect(ref?.ref).toBe(head2)
    const files = await dev.db.prepare('SELECT path FROM source_files ORDER BY path').all<{ path: string }>()
    expect(files.results.map((f) => f.path)).toEqual(['apple/Studio.swift', 'apple/Sync.swift', 'web/app.ts'])
    // And each commit's own files, as sentry-cli's patch_set names them, for suspect commits
    const own = await dev.db
      .prepare('SELECT path, kind FROM commit_files WHERE sha = ? ORDER BY path')
      .bind(head2)
      .all<{ path: string; kind: string }>()
    expect(own.results).toEqual([
      { path: 'old.txt', kind: 'D' },
      { path: 'web/app.ts', kind: 'A' },
    ])
  })

  it('stores a deploy from deploys new, for the release’s project, and lists it', async () => {
    cli('releases', 'new', '-p', 'e2e', 'app@3')
    const out = cli(
      'deploys',
      'new',
      '-r',
      'app@3',
      '-e',
      'staging',
      '-n',
      'Friday',
      '-u',
      'https://ci.example.com/1',
      '-t',
      '90',
    )
    expect(out).toContain('Friday')
    const rows = await dev.db
      .prepare("SELECT project_id, environment, name, url, started, finished FROM deploys WHERE release = 'app@3'")
      .all<Record<string, number | string>>()
    expect(rows.results).toMatchObject([
      { project_id: 1, environment: 'staging', name: 'Friday', url: 'https://ci.example.com/1' },
    ])
    const [row] = rows.results as { started: number; finished: number }[]
    expect(row.finished - row.started).toBe(90_000)
    expect(cli('deploys', 'list', '-r', 'app@3')).toContain('staging')
  })

  it('refuses uploads without a token', async () => {
    const r = await fetch(`${dev.origin}/api/0/organizations/x/chunk-upload/`)
    expect(r.status).toBe(401)
  })

  it('refuses a token of one project for another project’s upload, as Sentry does', async () => {
    await dev.db
      .prepare("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (2, 'other', 'other', ?, 0)")
      .bind('e2e0other0key00000000000000000ab')
      .run()
    const scoped = await createToken(dev.db, 'other only', 'test', Date.now(), 2)
    const assemble = (slug: string) =>
      fetch(`${dev.origin}/api/0/projects/crashyard/${slug}/files/difs/assemble/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${scoped}`, 'content-type': 'application/json' },
        body: '{}',
      })
    const refused = await assemble('e2e')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ detail: 'You do not have permission to perform this action.' })
    expect((await assemble('other')).status).toBe(200)
  })
})
