import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { sessionCounts, spanTransactions, summarize } from './ingest'

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

  it('keeps a child under its parent and siblings in order within a millisecond, as Rust and Elixir send them', () => {
    const span = (span_id: string, parent_span_id: string, op: string) => ({
      span_id,
      parent_span_id,
      op,
      start_timestamp: 1000,
      timestamp: 1000.001,
    })
    const t = summarize(
      {
        start_timestamp: 1000,
        timestamp: 1000.01,
        contexts: { trace: { span_id: 'root' } },
        // sentry-elixir lists siblings in no order: http.client first, though db started 3 µs before it
        spans: [
          span('ser', 'http', 'serialize'),
          { ...span('http', 'root', 'http.client'), start_timestamp: 1000.000003 },
          span('db', 'root', 'db'),
        ],
      },
      0,
    )
    expect(t?.spans.map((s) => [s.op, s.depth])).toEqual([
      ['db', 0],
      ['http.client', 0],
      ['serialize', 1],
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

describe('spanTransactions', () => {
  // As sentry-dart 10 streams a segment longer than its batch interval: the children first, the segment later
  const span = (span_id: string, segment: string, extra: Record<string, unknown> = {}) => ({
    span_id,
    trace_id: 'cd'.repeat(16),
    start_timestamp: 1000,
    end_timestamp: 1001,
    attributes: {
      'sentry.segment.id': { type: 'string', value: segment },
      'sentry.op': { type: 'string', value: 'db' },
    },
    ...extra,
  })
  const children = {
    items: [span('a', 'root', { parent_span_id: 'root' }), span('b', 'root', { parent_span_id: 'a' })],
  }
  const segment = { items: [span('root', 'root', { is_segment: true, name: 'checkout', end_timestamp: 1008 })] }

  it('holds children that come before their segment, and reads them into it once', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'p', 'p', 'k', 0)")
    // Sent twice, as a retry would
    for (let i = 0; i < 2; i++) expect((await spanTransactions(db, 1, children, 0)).transactions).toEqual([])
    const { transactions, release } = await spanTransactions(db, 1, segment, 0)
    expect(summarize(transactions[0], 0)?.spans.map((s) => [s.op, s.depth])).toEqual([
      ['db', 0],
      ['db', 1],
    ])
    await release()
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM pending_spans').get()).toEqual({ n: 0 })
  })
})
