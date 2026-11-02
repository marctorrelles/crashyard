import { describe, expect, it } from 'vitest'
import { normalizeActions } from './actions'
import { normalizeLogs } from './logs'
import { hashUser } from '../search/user'

// A log item as @sentry/browser's Sentry.logger.info(name, attributes) sends it, with the scope's user
const item = (body: string, attributes: Record<string, unknown>) => ({
  timestamp: 1_790_000_000.5,
  level: 'info',
  body,
  trace_id: 'a'.repeat(32),
  attributes: Object.fromEntries(
    Object.entries({
      'sentry.release': 'web@1.2.0',
      'sentry.environment': 'production',
      'user.id': '42',
      'user.email': 'ada@example.com',
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

  it('takes only the logs marked as actions, with their user as events hash it', () => {
    const [action, ...rest] = normalizeActions(payload, 0)
    expect(rest).toEqual([])
    expect(action).toEqual({
      timestamp: 1_790_000_000_500,
      name: 'song exported',
      userHash: hashUser('42'),
      release: 'web@1.2.0',
      environment: 'production',
      traceId: 'a'.repeat(32),
      properties: { format: 'wav', password: '[Filtered]' },
    })
  })

  it('leaves actions out of the logs', () => {
    expect(normalizeLogs(payload, 0).map((l) => l.body)).toEqual(['cache warmed'])
  })

  it('needs a name', () => {
    expect(normalizeActions({ items: [item('  ', { 'crashyard.action': 'true' })] }, 0)).toEqual([])
  })
})
