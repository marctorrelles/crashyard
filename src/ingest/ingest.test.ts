import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { handleIngest } from '../api/ingest'
import { changeIssues } from '../data/issues'
import { updateKey } from '../data/projects'
import { projectKey } from './auth'
import { readBody } from './body'
import { EnvelopeError, parseEnvelope, payloadJson } from './envelope'
import { eventIdOf, normalizeEvent, timestampOf } from './event'
import { fingerprintOf, mask } from './grouping'
import { loadExtraFields, scrub, scrubText, setExtraFields } from './scrub'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { type Project, storeEvent, TAG_VALUES, transitionOf } from './store'

// handleIngest without the Wasm module or the channels: nothing here needs symbols or sends a notice
vi.mock('../symbols/module', () => ({ sharedSymbolic: () => Promise.reject(new Error('no symbols in tests')) }))
vi.mock('../notify/dispatch', () => ({ dispatch: async () => {} }))

const fixture = (path: string) => readFileSync(`test/fixtures/${path}`)
const event = (name: string) => JSON.parse(readFileSync(`test/fixtures/events/${name}.json`, 'utf8'))
const bytes = (s: string) => new TextEncoder().encode(s)

describe('envelopes', () => {
  it('reads items with and without a length', () => {
    const env = parseEnvelope(
      bytes(
        '{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc"}\n{"type":"event","length":13}\n{"message":1}\n{"type":"session"}\n{"sid":"a"}\n',
      ),
    )
    expect(env.header.event_id).toBe('9ec79c33ec9942ab8353589fcb2e04dc')
    expect(env.items.map((i) => i.header.type)).toEqual(['event', 'session'])
    expect(payloadJson(env.items[0])).toEqual({ message: 1 })
    expect(payloadJson(env.items[1])).toEqual({ sid: 'a' })
  })

  it('takes a length-prefixed payload byte for byte, newlines and all', () => {
    const env = parseEnvelope(bytes('{}\n{"type":"attachment","length":5}\na\nb\nc\n{"type":"event"}\n{}'))
    expect(new TextDecoder().decode(env.items[0].payload)).toBe('a\nb\nc')
    expect(env.items[1].header.type).toBe('event')
  })

  it('reads GlitchTip’s parity fixtures, and refuses a truncated one', () => {
    expect(parseEnvelope(fixture('envelopes/simple_event.envelope')).items[0].header.type).toBe('event')
    expect(parseEnvelope(fixture('envelopes/header_only.envelope')).items).toHaveLength(0)
    expect(parseEnvelope(fixture('envelopes/unknown_item.envelope')).items.length).toBeGreaterThan(0)
    expect(() => parseEnvelope(fixture('envelopes/truncated.envelope'))).toThrow(EnvelopeError)
  })

  it('reads a gzip body', async () => {
    const gz = new Response(new Blob([bytes('{"a":1}')]).stream().pipeThrough(new CompressionStream('gzip')))
    const request = new Request('https://x/', {
      method: 'POST',
      body: await gz.arrayBuffer(),
      headers: { 'content-encoding': 'gzip' },
    })
    expect(new TextDecoder().decode(await readBody(request))).toBe('{"a":1}')
  })

  it('finds the project key wherever an SDK puts it', () => {
    const url = new URL('https://x/api/1/envelope/?sentry_key=fromquery')
    const auth = (h: Record<string, string>) => projectKey(new Request(url, { headers: h }), new URL('https://x/'))
    expect(
      auth({ 'x-sentry-auth': 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=sentry.cocoa/9.10.0' }),
    ).toBe('abc123')
    expect(projectKey(new Request(url), url)).toBe('fromquery')
    expect(projectKey(new Request('https://x/'), new URL('https://x/'), 'https://dsnkey@x/1')).toBe('dsnkey')
  })
})

describe('events', () => {
  it('takes an iOS crash’s stack from the crashed thread, frames without symbols and all', async () => {
    const e = await normalizeEvent(event('ios-crash'))
    expect(e.type).toBe('error')
    expect(e.title).toMatch(/^EXC_BAD_ACCESS: crash > crashButtonTouchUpInside: > doCrash >/)
    expect(e.exceptions.at(-1)!.frames.length).toBe(31)
    expect(e.level).toBe('fatal')
    expect(e.tags.device).toBe('iPhone15,3')
    expect(e.tags['user.id']).toBeUndefined()
    expect(e.userHash).toMatch(/^[0-9a-f]{32}$/)
    expect(e.debugImages.length).toBe(12)
  })

  it('keeps every thread of an iOS crash, the crashed one first with its stack on the exception', async () => {
    const e = await normalizeEvent(event('ios-crash'))
    expect(e.threads).toHaveLength(11)
    expect(e.threads![0]).toMatchObject({ id: '0', crashed: true, frames: [] })
    expect(e.threads!.find((t) => t.name === 'com.apple.uikit.eventfetch-thread')!.frames).toHaveLength(12)
    expect(await fingerprintOf(e)).toBe(await fingerprintOf({ ...e, threads: undefined }))
  })

  it('keeps 32 threads at most, of 100 frames each, the current one first', async () => {
    const frames = Array.from({ length: 150 }, (_, i) => ({ function: `f${i}` }))
    const threads = Array.from({ length: 40 }, (_, i) => ({ id: i, current: i === 35, stacktrace: { frames } }))
    const e = await normalizeEvent({ message: 'hang', threads: { values: threads } })
    expect(e.threads).toHaveLength(32)
    expect(e.threads![0]).toMatchObject({ id: '35', current: true })
    expect(e.threads![1].id).toBe('0')
    expect(e.threads![0].frames).toHaveLength(100)
    expect(e.threads![0].frames.at(-1)!.function).toBe('f149') // the innermost frames stay
  })

  it('reads JS, Python and sentry-cli events into a title and culprit', async () => {
    for (const name of [
      'small-js-error',
      'js-error-with-context',
      'js-event-with-unix-timestamp',
      'python-zero-division',
    ]) {
      const e = await normalizeEvent(event(name))
      expect(e.title, name).not.toBe('<unlabeled event>')
      expect(e.exceptions.length, name).toBeGreaterThan(0)
    }
    const cli = await normalizeEvent(event('sentry-cli-send-event-no-level'))
    expect(cli.level).toBe('error')
    expect(cli.type).toBe('message')
  })

  it('keeps the request and extra data, scrubbed, within their limits', async () => {
    const e = await normalizeEvent({
      message: 'x',
      request: {
        method: 'post',
        url: 'https://api.example.org/songs?token=abc&page=2',
        query_string: [
          ['api_key', 'k'],
          ['q', 'me@mail.example.org'],
        ],
        headers: { Authorization: 'Bearer secret', 'User-Agent': 'App/1.0', Cookie: 'sid=1' },
        data: { password: 'p', title: 'a'.repeat(10_000) },
      },
      extra: { build: 42, secret: 'x', blob: 'b'.repeat(20_000), after: 1 },
    })
    expect(e.request).toMatchObject({
      method: 'POST',
      url: 'https://api.example.org/songs?token=[Filtered]&page=2',
      query: 'api_key=[Filtered]&q=%5Bemail%5D',
      headers: [
        ['Authorization', '[Filtered]'],
        ['User-Agent', 'App/1.0'],
        ['Cookie', '[Filtered]'],
      ],
    })
    expect(e.request!.body!.length).toBe(8 * 1024)
    expect(e.request!.body).toMatch(/^\{"password":"\[Filtered\]","title":"aaa/)
    expect(e.extra).toEqual({ build: 42, secret: '[Filtered]' })
    expect(e._trimmed).toEqual(['request body', 'extra'])
    const plain = await normalizeEvent(event('small-js-error'))
    expect(plain._trimmed).toBeUndefined()
  })

  it('keeps no client IP from a request’s headers or env', async () => {
    const ip = '203.0.113.7'
    const e = await normalizeEvent({
      message: 'x',
      request: {
        url: 'https://example.org/',
        headers: [
          ['X-Forwarded-For', ip],
          ['x-real-ip', ip],
          ['CF-Connecting-IP', ip],
          ['True-Client-IP', ip],
          ['Forwarded', `for=${ip}`],
          ['Fastly-Client-IP', ip],
          ['Fly-Client-IP', ip],
          ['X-Vercel-Forwarded-For', ip],
          ['X-AppEngine-User-IP', ip],
          ['X-Envoy-External-Address', ip],
          ['Accept', 'text/html'],
        ],
        env: { REMOTE_ADDR: ip },
      },
    })
    expect(e.request!.headers).toEqual([['Accept', 'text/html']])
    expect(JSON.stringify(e)).not.toContain(ip)
  })

  it('reads timestamps and ids in either form', () => {
    expect(timestampOf(1700000000.5)).toBe(1700000000500)
    expect(timestampOf('2026-04-22T16:10:51Z')).toBe(Date.parse('2026-04-22T16:10:51Z'))
    expect(timestampOf('2026-04-22T16:10:51')).toBe(Date.parse('2026-04-22T16:10:51Z'))
    expect(eventIdOf('9EC79C33-EC99-42AB-8353-589FCB2E04DC')).toBe('9ec79c33ec9942ab8353589fcb2e04dc')
    expect(eventIdOf('nope')).toBeUndefined()
  })
})

describe('grouping', () => {
  it('groups the same crash at different image addresses as one issue', async () => {
    const a = event('ios-crash')
    const b = structuredClone(a)
    // Another run of the same build: every image loaded 0x1000000 higher, so every address moves but no offset does
    const shift = (hex: string) => `0x${(BigInt(hex) + 0x1000000n).toString(16)}`
    for (const t of b.threads.values)
      for (const f of t.stacktrace?.frames ?? []) {
        if (f.instruction_addr) f.instruction_addr = shift(f.instruction_addr)
        if (f.image_addr) f.image_addr = shift(f.image_addr)
      }
    b.event_id = 'ffffffffffffffffffffffffffffffff'
    expect(await fingerprintOf(await normalizeEvent(b))).toBe(await fingerprintOf(await normalizeEvent(a)))
  })

  it('masks numbers, ids and quoted text in messages', () => {
    expect(mask('user 42 not found in "eu-west"')).toBe(mask('user 7 not found in "us-east"'))
    expect(mask('id 9ec79c33-ec99-42ab-8353-589fcb2e04dc')).toBe('id <uuid>')
  })

  it('uses an SDK’s fingerprint, with {{ default }} standing for the default', async () => {
    const base = await normalizeEvent(event('small-js-error'))
    const custom = { ...base, fingerprint: ['checkout'] }
    const withDefault = { ...base, fingerprint: ['{{ default }}', 'checkout'] }
    expect(await fingerprintOf(custom)).not.toBe(await fingerprintOf(base))
    expect(await fingerprintOf(withDefault)).not.toBe(await fingerprintOf(custom))
    expect(await fingerprintOf({ ...base, fingerprint: ['{{ default }}'] })).toBe(await fingerprintOf(base))
  })
})

describe('scrubbing', () => {
  it('also takes out the deployment’s own field names, in any case, from settings once a minute', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO settings (key, value) VALUES ('privacy.scrub_fields', '["IBAN", " pin "]')`)
    await loadExtraFields(db, 1_000_000)
    expect(scrub({ iban: 'ES00', customer_pin: '1234', name: 'x' })).toEqual({
      iban: '[Filtered]',
      customer_pin: '[Filtered]',
      name: 'x',
    })
    db.sqlite.exec(`UPDATE settings SET value = '[]'`)
    await loadExtraFields(db, 1_030_000)
    expect(scrub({ iban: 'ES00' })).toEqual({ iban: '[Filtered]' })
    await loadExtraFields(db, 1_061_000)
    expect(scrub({ iban: 'ES00' })).toEqual({ iban: 'ES00' })
    setExtraFields([])
  })

  it('takes secrets out of keys and text', () => {
    expect(scrubText('release app@1.2.0, web@2026.10.12; me@mail.example.org')).toBe(
      'release app@1.2.0, web@2026.10.12; [email]',
    )
    expect(scrub({ password: 'x', nested: { apiKey: 'y', note: 'mail me at a@b.co, Bearer abc.def' } })).toEqual({
      password: '[Filtered]',
      nested: { apiKey: '[Filtered]', note: 'mail me at [email], Bearer [Filtered]' },
    })
  })
})

describe('grouping anonymous and synthetic frames', () => {
  const ev = async (value: string, frames: Record<string, unknown>[], synthetic = false) =>
    normalizeEvent({
      exception: { values: [{ type: 'Error', value, mechanism: { synthetic }, stacktrace: { frames } }] },
    })
  it('tells two errors in anonymous functions apart by their line of source', async () => {
    const a = await ev('a', [
      { function: '?', filename: 'app.js', lineno: 3, context_line: 'throw new Error("a")', in_app: true },
    ])
    const b = await ev('b', [
      { function: '?', filename: 'app.js', lineno: 9, context_line: 'throw new Error("b")', in_app: true },
    ])
    expect(await fingerprintOf(a)).not.toBe(await fingerprintOf(b))
  })
  it('titles a synthetic exception by its message, as a message', async () => {
    const e = await ev('something odd', [{ function: 'run', in_app: true }], true)
    expect(e.title).toBe('something odd')
    expect(e.type).toBe('message')
  })
})

describe('reopening', () => {
  const issue = (over: Record<string, unknown>) =>
    ({
      status: 'unresolved',
      resolved_in_release: null,
      fixed_in_release: null,
      ignore_until_count: null,
      ignore_until: null,
      ignore_until_users: null,
      count: 5,
      user_count: 2,
      ...over,
    }) as never
  it('reopens a resolved issue, and one resolved in a release only for another release', () => {
    expect(transitionOf(issue({ status: 'resolved' }), undefined, 0)).toBe('regressed')
    expect(transitionOf(issue({ status: 'resolved', resolved_in_release: '1.0' }), '1.0', 0)).toBeUndefined()
    expect(transitionOf(issue({ status: 'resolved', resolved_in_release: '1.0' }), undefined, 0)).toBeUndefined()
    expect(transitionOf(issue({ status: 'resolved', resolved_in_release: '1.0' }), '1.1', 0)).toBe('regressed')
  })
  it('reopens one resolved in a release for it or a newer one, not an older one', () => {
    const fixed = issue({ status: 'resolved', fixed_in_release: '2.0' })
    expect(transitionOf(fixed, '2.0', 0)).toBe('regressed')
    expect(transitionOf(fixed, '2.1', 0, false, false)).toBe('regressed')
    expect(transitionOf(fixed, '1.9', 0, false, true)).toBeUndefined()
    expect(transitionOf(fixed, undefined, 0)).toBeUndefined()
  })
  it('orders releases by when they were made, else their first event', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      INSERT INTO releases (project_id, version, created_at) VALUES (1, '2.0', 2000), (1, '1.9', 1000)`)
    const project = {
      id: 1,
      slug: 'a',
      name: 'a',
      daily_event_quota: 1e6,
      daily_log_quota: 1e6,
      daily_transaction_quota: 1e6,
    }
    const e = { ...(await normalizeEvent({ message: 'm' }, 3000)), release: '1.0' }
    const first = (await storeEvent(db, project, e, 'fp'))!
    db.sqlite.exec(`UPDATE issues SET status = 'resolved', fixed_in_release = '2.0'`)
    const at = async (release: string, id: string) =>
      (await storeEvent(db, project, { ...e, id: id.repeat(32), release, received: 4000 }, 'fp'))?.transition
    expect(await at('1.9', 'b')).toBeUndefined()
    expect(await at('3.0', 'c')).toBe('regressed')
    expect(first.isNew).toBe(true)
  })
  it('ends an ignore by count or by date', () => {
    expect(transitionOf(issue({ status: 'ignored', ignore_until_count: 6 }), undefined, 0)).toBe('ignore_expired')
    expect(transitionOf(issue({ status: 'ignored', ignore_until_count: 10 }), undefined, 0)).toBeUndefined()
    expect(transitionOf(issue({ status: 'ignored', ignore_until: 100 }), undefined, 100)).toBe('ignore_expired')
  })
  it('ends an ignore by users, only for a user the issue hadn’t had', () => {
    const ignored = issue({ status: 'ignored', ignore_until_users: 3 })
    expect(transitionOf(ignored, undefined, 0, true)).toBe('ignore_expired')
    expect(transitionOf(ignored, undefined, 0, false)).toBeUndefined()
  })
})

describe('storing', () => {
  it('keeps 100 values of a tag per issue and counts the rest under other', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
    const project = { id: 1, slug: 'a', name: 'a' } as Project
    for (let i = 0; i < TAG_VALUES + 50; i++) {
      const e = await normalizeEvent({ message: 'same', tags: { url: `/page/${i % (TAG_VALUES + 25)}` } }, 1000 + i)
      await storeEvent(db, project, e, 'one')
    }
    const values = db.sqlite
      .prepare("SELECT value, count FROM issue_tag_values WHERE key = 'url' ORDER BY count DESC, value")
      .all() as { value: string; count: number }[]
    expect(values).toHaveLength(TAG_VALUES + 1)
    // 125 values, then the first 25 again: 25 past the cap, and 25 kept ones seen twice
    expect(values[0]).toEqual({ value: 'other', count: 25 })
    expect(values.filter((v) => v.count === 2)).toHaveLength(25)
    expect(values.reduce((n, v) => n + v.count, 0)).toBe(TAG_VALUES + 50)
  })
})

describe('client keys', () => {
  const NOW = Date.UTC(2026, 9, 26, 12)
  // Ingest caches a key a minute, by project and key: each test has a project of its own
  let next = 10
  async function setup() {
    const id = next++
    const env = { DB: sqliteD1(), FILES: memoryR2() }
    env.DB.sqlite
      .exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (${id}, 'k', 'k', 'first', 0);
      INSERT INTO project_keys (project_id, public_key, label, created_at) VALUES (${id}, 'second', 'CI', 0);`)
    const send = async (key: string, project = id) => {
      const waits: Promise<unknown>[] = []
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext
      const event = { event_id: crypto.randomUUID().replace(/-/g, ''), message: 'hello', timestamp: NOW / 1000 }
      const response = await handleIngest(
        new Request(`https://x/api/${project}/store/?sentry_key=${key}`, {
          method: 'POST',
          body: JSON.stringify(event),
        }),
        env,
        ctx,
        project,
        'store',
      )
      await Promise.all(waits)
      return response
    }
    const keyId = (key: string) =>
      (env.DB.sqlite.prepare('SELECT id FROM project_keys WHERE public_key = ?').get(key) as { id: number }).id
    return { env, send, keyId, id }
  }

  it('takes the key made from the project’s own, and a second key of the same project', async () => {
    const { env, send, keyId, id } = await setup()
    expect((await send('first')).status).toBe(200)
    expect((await send('second')).status).toBe(200)
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(id)).toEqual({ n: 2 })
    expect(env.DB.sqlite.prepare('SELECT events FROM key_days WHERE key_id = ?').get(keyId('second'))).toEqual({
      events: 1,
    })
    expect((await send('second', id + 100)).status).toBe(403)
  })

  it('answers a turned-off key with Relay’s 403', async () => {
    const { env, send, keyId, id } = await setup()
    await updateKey(env.DB, id, keyId('second'), { label: 'CI', enabled: false, daily_limit: null })
    const refused = await send('second')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ detail: 'event submission rejected with_reason: ProjectId' })
    expect((await send('first')).status).toBe(200)
  })

  it('holds a key past its daily limit with a 429 and the key’s rate limit, and not the project’s other keys', async () => {
    const { env, send, keyId, id } = await setup()
    await updateKey(env.DB, id, keyId('second'), { label: 'CI', enabled: true, daily_limit: 2 })
    expect((await send('second')).status).toBe(200)
    expect((await send('second')).status).toBe(200)
    const refused = await send('second')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('x-sentry-rate-limits')).toMatch(
      /^\d+:error;default;security;attachment;feedback:key:key_quota$/,
    )
    expect((await send('first')).status).toBe(200)
  })
})

describe('filtered events', () => {
  const NOW = Date.UTC(2026, 9, 26, 12)
  it('count as filtered, not towards the quota or the key, for a filter, a discarded issue or a domain', async () => {
    const env = { DB: sqliteD1(), FILES: memoryR2() }
    const filters = JSON.stringify({ releases: ['bad*'], domains: ['app.example.com'] })
    env.DB.sqlite.exec(
      `INSERT INTO projects (id, slug, name, public_key, created_at, filters) VALUES (90, 'f', 'f', 'fk', 0, '${filters}')`,
    )
    const send = async (event: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const waits: Promise<unknown>[] = []
      const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext
      const response = await handleIngest(
        new Request('https://x/api/90/store/?sentry_key=fk', {
          method: 'POST',
          headers,
          body: JSON.stringify({ event_id: crypto.randomUUID().replace(/-/g, ''), timestamp: NOW / 1000, ...event }),
        }),
        env,
        ctx,
        90,
        'store',
      )
      await Promise.all(waits)
      return response
    }
    const day = () => env.DB.sqlite.prepare('SELECT events, filtered FROM project_days WHERE project_id = 90').get()
    const keyDay = () => env.DB.sqlite.prepare('SELECT SUM(events) AS n FROM key_days').get()
    expect((await send({ message: 'kept' })).status).toBe(200)
    expect((await send({ message: 'old build', release: 'bad-1' })).status).toBe(200)
    expect(day()).toEqual({ events: 1, filtered: 1 })
    expect(keyDay()).toEqual({ n: 1 })
    // Delete and discard: the issue's next events are dropped too
    const { id } = env.DB.sqlite.prepare('SELECT id FROM issues').get() as { id: number }
    await changeIssues(env.DB, [id], { action: 'delete', discard: true }, 'me', NOW)
    expect((await send({ message: 'kept' })).status).toBe(200)
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM issues').get()).toEqual({ n: 0 })
    expect(day()).toEqual({ events: 1, filtered: 2 })
    // An origin not allowed is refused whole, as Relay's Cors
    const refused = await send({ message: 'x' }, { origin: 'https://evil.com' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ detail: 'event submission rejected with_reason: Cors' })
    expect((await send({ message: 'other' }, { origin: 'https://app.example.com' })).status).toBe(200)
    expect(day()).toEqual({ events: 2, filtered: 3 })
    expect(keyDay()).toEqual({ n: 2 })
  })
})

describe('what a pass that fails costs', () => {
  const NOW = Date.UTC(2026, 9, 26, 12)
  const setup = () => {
    const env = { DB: sqliteD1(), FILES: memoryR2() }
    env.DB.sqlite.exec(
      `INSERT INTO projects (id, slug, name, public_key, created_at, filters) VALUES (6, 'r', 'r', 'rk6', 0, '{"releases":["bad*"]}')`,
    )
    return env
  }
  const send = async (env: ReturnType<typeof setup>, lines: unknown[]) => {
    // Strings are raw payloads, as an attachment's
    const waits: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as unknown as ExecutionContext
    const response = await handleIngest(
      new Request('https://x/api/6/envelope/?sentry_key=rk6', {
        method: 'POST',
        body: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'),
      }),
      env,
      ctx,
      6,
      'envelope',
    )
    await Promise.all(waits)
    return response
  }
  const pending = (env: ReturnType<typeof setup>) =>
    [...env.FILES.objects.keys()].filter((k) => k.startsWith('pending/'))

  it('never fails an envelope over counting what was filtered, so its logs count once', async () => {
    const env = setup()
    const prepare = env.DB.prepare.bind(env.DB)
    let failOnce = true
    env.DB.prepare = (sql: string) => {
      if (failOnce && sql.includes('filtered = filtered + excluded.filtered')) {
        failOnce = false
        throw new Error('D1 hiccup')
      }
      return prepare(sql)
    }
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      const response = await send(env, [
        {},
        { type: 'event' },
        { event_id: 'a'.repeat(32), message: 'kept', timestamp: NOW / 1000 },
        { type: 'event' },
        { event_id: 'b'.repeat(32), message: 'old', release: 'bad-1', timestamp: NOW / 1000 },
        { type: 'log' },
        { items: [{ timestamp: NOW / 1000, level: 'info', body: 'hi', attributes: {} }] },
      ])
      expect(response.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
    expect(failOnce).toBe(false)
    expect(pending(env)).toEqual([])
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM logs').get()).toEqual({ n: 1 })
    expect(env.DB.sqlite.prepare('SELECT events, logs FROM project_days').get()).toEqual({ events: 1, logs: 1 })
  })

  it('keeps two attachments of the same name, and writes no second row when the envelope comes again', async () => {
    const env = setup()
    const lines = [
      { event_id: 'c'.repeat(32) },
      { type: 'event' },
      { event_id: 'c'.repeat(32), message: 'boom', timestamp: NOW / 1000 },
      { type: 'attachment', filename: 'log.txt', content_type: 'text/plain' },
      'first',
      { type: 'attachment', filename: 'log.txt', content_type: 'text/plain' },
      'second',
    ]
    for (let i = 0; i < 2; i++) expect((await send(env, lines)).status).toBe(200)
    expect(env.DB.sqlite.prepare('SELECT filename, r2_key FROM attachments ORDER BY id').all()).toEqual([
      { filename: 'log.txt', r2_key: `attachments/6/${'c'.repeat(32)}/1-log.txt` },
      { filename: 'log.txt', r2_key: `attachments/6/${'c'.repeat(32)}/2-log.txt` },
    ])
  })

  it('answers a second send of the same event 200, stores it once, and never fails it', async () => {
    const env = setup()
    const lines = [{}, { type: 'event' }, { event_id: 'd'.repeat(32), message: 'twice', timestamp: NOW / 1000 }]
    for (let i = 0; i < 2; i++) {
      const response = await send(env, lines)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ id: 'd'.repeat(32) })
    }
    expect(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
    expect(env.DB.sqlite.prepare('SELECT count FROM issues').get()).toEqual({ count: 1 })
    expect([...env.FILES.objects.keys()].filter((k) => !k.startsWith('envelopes/'))).toEqual([])
  })

  it('holds no envelope of sessions alone', async () => {
    const env = setup()
    const at = new Date(NOW).toISOString()
    const session = { sid: 'a', status: 'exited', started: at, timestamp: at, attrs: { release: '1.0' } }
    expect((await send(env, [{}, { type: 'session' }, session])).status).toBe(200)
    expect(env.FILES.objects.size).toBe(0)
    expect((await send(env, [{}, { type: 'session' }, session, { type: 'event' }, { message: 'boom' }])).status).toBe(
      200,
    )
    expect(env.FILES.objects.size).toBe(1) // the event's envelopes/ copy; the held one went once stored
    expect(pending(env)).toEqual([])
  })

  it('answers a check-in whose slug isn’t valid in the address with a 400 and a sentence', async () => {
    const env = setup()
    const ctx = { waitUntil: () => {} } as unknown as ExecutionContext
    const request = new Request('https://x/api/6/cron/%E0%A4%A/rk6/?status=ok')
    const response = await handleIngest(request, env, ctx, 6, 'cron', ['%E0%A4%A', 'rk6'])
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      detail: 'The monitor slug in the address isn’t valid. Use letters, numbers, dots, dashes and underscores.',
    })
  })
})
