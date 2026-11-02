import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { normalizeActions, platformOf } from './actions'
import { normalizeLogs, storeLogs } from './logs'
import { hashUser } from '../search/user'

// A log item as @sentry/core 11.9's logger sends it (logs/internal.js): typed attributes, the scope's user as
// user.id, user.email and user.name
const item = (body: string, attributes: Record<string, unknown>) => ({
  timestamp: 1_790_000_000.5,
  level: 'info',
  body,
  trace_id: 'a'.repeat(32),
  attributes: Object.fromEntries(
    Object.entries({
      'sentry.release': 'web@1.2.0',
      'sentry.environment': 'production',
      'sentry.sdk.name': 'sentry.javascript.react',
      'user.id': '42',
      'user.email': 'ada@example.com',
      'os.name': 'macOS',
      'browser.name': 'Safari',
      ...attributes,
    }).map(([k, v]) => [k, { value: v, type: typeof v === 'number' ? 'integer' : typeof v }]),
  ),
})

describe('actions', () => {
  const payload = {
    items: [
      item('song exported', { 'crashyard.action': true, format: 'wav', password: 'hunter2' }),
      item('cache warmed', { entries: 12 }),
    ],
  }

  it('takes only the logs marked as actions, with their user as events hash it, and where they were', () => {
    const [action, ...rest] = normalizeActions(payload, 0, 'ES')
    expect(rest).toEqual([])
    expect(action).toEqual({
      timestamp: 1_790_000_000_500,
      name: 'song exported',
      userHash: hashUser('42'),
      release: 'web@1.2.0',
      environment: 'production',
      traceId: 'a'.repeat(32),
      platform: 'Web',
      os: 'macOS',
      device: undefined,
      browser: 'Safari',
      country: 'ES',
      properties: { format: 'wav', password: '[Filtered]' },
    })
  })

  it('hashes a numeric id as events do, and takes user.name when there is no id or email', () => {
    const numeric = item('signed up', { 'crashyard.action': true, 'user.id': 42 })
    expect(normalizeActions({ items: [numeric] }, 0)[0].userHash).toBe(hashUser('42'))
    const named = item('signed up', { 'crashyard.action': true })
    delete (named.attributes as Record<string, unknown>)['user.id']
    delete (named.attributes as Record<string, unknown>)['user.email']
    ;(named.attributes as Record<string, unknown>)['user.name'] = { value: 'ada', type: 'string' }
    expect(normalizeActions({ items: [named] }, 0)[0].userHash).toBe(hashUser('ada'))
  })

  it('scrubs the name as a log body is', () => {
    const [a] = normalizeActions({ items: [item('invited ada@example.com', { 'crashyard.action': true })] }, 0)
    expect(a.name).not.toContain('ada@example.com')
  })

  it('leaves actions out of the logs', () => {
    expect(normalizeLogs(payload, 0).map((l) => l.body)).toEqual(['cache warmed'])
  })

  it('needs a name', () => {
    expect(normalizeActions({ items: [item('  ', { 'crashyard.action': 'true' })] }, 0)).toEqual([])
  })

  it('names platforms from the SDK', () => {
    expect(platformOf('sentry.cocoa')).toBe('Apple')
    expect(platformOf('sentry.java.android')).toBe('Android')
    expect(platformOf('sentry.javascript.react-native')).toBe('React Native')
    expect(platformOf('sentry.javascript.node')).toBe('Server')
    expect(platformOf('sentry.dart.flutter')).toBe('Flutter')
    expect(platformOf(undefined)).toBeUndefined()
  })

  it('stores an item’s logs and actions in one batch, both counted towards the daily log limit', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'p', 'p', 'k', 0)")
    await storeLogs(db, 1, normalizeLogs(payload, 0), 0, '2026-11-02', normalizeActions(payload, 0, 'ES'))
    const actions = db.sqlite.prepare('SELECT name, country, properties FROM actions').all()
    expect(actions).toEqual([
      { name: 'song exported', country: 'ES', properties: '{"format":"wav","password":"[Filtered]"}' },
    ])
    expect(db.sqlite.prepare('SELECT logs FROM project_days').get()).toEqual({ logs: 2 })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM logs').get()).toEqual({ n: 1 })
  })
})
