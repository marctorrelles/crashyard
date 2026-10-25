import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { projectKey } from './auth'
import { readBody } from './body'
import { EnvelopeError, parseEnvelope, payloadJson } from './envelope'
import { eventIdOf, normalizeEvent, timestampOf } from './event'
import { fingerprintOf, mask } from './grouping'
import { scrub, scrubText } from './scrub'
import { transitionOf } from './store'

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
      ignore_until_count: null,
      ignore_until: null,
      count: 5,
      ...over,
    }) as never
  it('reopens a resolved issue, and one resolved in a release only for another release', () => {
    expect(transitionOf(issue({ status: 'resolved' }), undefined, 0)).toBe('regressed')
    expect(transitionOf(issue({ status: 'resolved', resolved_in_release: '1.0' }), '1.0', 0)).toBeUndefined()
    expect(transitionOf(issue({ status: 'resolved', resolved_in_release: '1.0' }), undefined, 0)).toBeUndefined()
    expect(transitionOf(issue({ status: 'resolved', resolved_in_release: '1.0' }), '1.1', 0)).toBe('regressed')
  })
  it('ends an ignore by count or by date', () => {
    expect(transitionOf(issue({ status: 'ignored', ignore_until_count: 6 }), undefined, 0)).toBe('ignore_expired')
    expect(transitionOf(issue({ status: 'ignored', ignore_until_count: 10 }), undefined, 0)).toBeUndefined()
    expect(transitionOf(issue({ status: 'ignored', ignore_until: 100 }), undefined, 100)).toBe('ignore_expired')
  })
})
