import { describe, expect, it } from 'vitest'
import { sessionCounts, summarize } from './ingest'

describe('summarize', () => {
  it('reads a transaction as sentry-cocoa and sentry-android send it, spans as a waterfall', () => {
    const t = summarize(
      {
        event_id: 'ab'.repeat(16),
        transaction: 'SongView',
        start_timestamp: 1000,
        timestamp: 1000.5,
        release: 'app@1.0 (9)',
        contexts: { trace: { trace_id: 'cd'.repeat(16), span_id: 'root', op: 'ui.load', status: 'ok' } },
        spans: [
          {
            span_id: 'b',
            parent_span_id: 'a',
            op: 'db',
            description: 'SELECT',
            start_timestamp: 1000.2,
            timestamp: 1000.3,
          },
          { span_id: 'a', parent_span_id: 'root', op: 'file.read', start_timestamp: 1000.1, timestamp: 1000.4 },
        ],
      },
      0,
    )
    expect(t).toMatchObject({ name: 'SongView', duration: 500, error: false, release: 'app@1.0 (9)' })
    expect(t?.spans).toMatchObject([
      { op: 'file.read', start: 100, duration: 300, depth: 0 },
      { op: 'db', description: 'SELECT', start: 200, duration: 100, depth: 1 },
    ])
  })

  it('counts a crashed session and aggregates', () => {
    expect(sessionCounts('session', { init: true, status: 'crashed', attrs: { release: 'r' } }, 0)).toMatchObject([
      { release: 'r', started: 1, crashed: 1 },
    ])
    expect(sessionCounts('session', { init: false, status: 'unhandled', errors: 1 }, 0)).toMatchObject([
      { started: 0, crashed: 1 },
    ])
    expect(sessionCounts('sessions', { aggregates: [{ exited: 2, errored: 1 }] }, 0)).toMatchObject([
      { started: 3, errored: 1 },
    ])
  })
})
