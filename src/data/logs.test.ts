import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { csvField, exportLogs, MAX_LINES } from './export'
import { hourly, readsHours } from './logs'

const HOUR = 36e5
const DAY = 864e5

describe('logs', () => {
  it('reads the hourly rollup for hours and days of level and project alone', () => {
    for (const q of ['', 'level:error', '!level:[debug,trace] project:a', '!project:[a,b] level:warning'])
      expect(readsHours(q, '1h', 7 * DAY), q).toBe(true)
    expect(readsHours('', '1d', 30 * DAY)).toBe(true)
    // A word, any other key, a minute's buckets or a span of part-hours read the logs
    for (const q of ['crash', 'level:error slow', 'release:1.0', 'song:42', 'has:song', 'message:x', 'trace:abc'])
      expect(readsHours(q, '1h', 7 * DAY), q).toBe(false)
    expect(readsHours('', '5m', 6 * HOUR)).toBe(false)
    expect(readsHours('', '1m', HOUR)).toBe(false)
    expect(readsHours('', '1d', 30 * DAY + 1)).toBe(false)
  })

  it('takes a span’s whole hours from the rollup and the part-hours at its ends from the logs', () => {
    const from = Date.UTC(2026, 9, 1, 10, 30)
    const to = Date.UTC(2026, 9, 2, 10, 30)
    expect(hourly([[from, to]]).params).toEqual([
      Date.UTC(2026, 9, 1, 11),
      Date.UTC(2026, 9, 2, 10),
      from,
      Date.UTC(2026, 9, 1, 11),
      Date.UTC(2026, 9, 2, 10),
      to,
    ])
    // On the hour, the logs' parts are empty; within one hour, it's all logs
    expect(hourly([[Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2)]]).params).toEqual([
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 2),
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 1),
      Date.UTC(2026, 9, 2),
      Date.UTC(2026, 9, 2),
    ])
    const [a, b] = [Date.UTC(2026, 9, 1, 10, 10), Date.UTC(2026, 9, 1, 10, 50)]
    expect(hourly([[a, b]]).params).toEqual([b, b, a, b, b, b])
    // Two spans, two terms each: D1 allows five in a compound SELECT
    expect(
      hourly([
        [a, b],
        [b, b + HOUR],
      ]).sql.match(/UNION ALL/g),
    ).toHaveLength(3)
  })
})

describe('export', () => {
  it('escapes quotes, commas and line breaks in CSV, and defuses formulas', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('two\nlines')).toBe('"two\nlines"')
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvField(null)).toBe('')
  })

  it('streams the newest 10,000 lines, a thousand at a time, none twice', async () => {
    const db = sqliteD1()
    const now = Date.UTC(2026, 9, 26, 12)
    // Several logs a millisecond, so pages break between logs of the same time
    db.sqlite.exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'p', 'p', 'k', 0);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MAX_LINES + 5})
        INSERT INTO logs (project_id, timestamp, received, level, body, attributes)
        SELECT 1, ${now - 10_000} + i / 3, 0, 'info', 'line ' || i, '{}' FROM n;`)
    const text = (format: 'csv' | 'jsonl') =>
      exportLogs(db, { query: '', window: { range: '24h' } }, format, now).then((s) => new Response(s).text())
    const csv = (await text('csv')).trimEnd().split('\r\n')
    expect(csv).toHaveLength(MAX_LINES + 1)
    const bodies = (await text('jsonl'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l).body)
    expect(new Set(bodies).size).toBe(MAX_LINES)
    expect(bodies[0]).toBe(`line ${MAX_LINES + 5}`)
  })

  it('writes the newest logs of a search, times in UTC', async () => {
    const db = sqliteD1()
    const now = Date.UTC(2026, 9, 26, 12)
    db.sqlite
      .exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'pocketband', 'pocketband', 'k', 0);
      INSERT INTO logs (project_id, timestamp, received, level, body, attributes) VALUES
        (1, ${now - 60e3}, 0, 'error', 'Export failed, "disk full"', '{"song":42}'),
        (1, ${now - 120e3}, 0, 'info', 'Saved', '{}'),
        (1, ${now - 2 * DAY}, 0, 'error', 'Too old', '{}')`)
    const read = (stream: ReadableStream<Uint8Array>) => new Response(stream).text()
    const csv = await read(await exportLogs(db, { query: 'level:error', window: { range: '24h' } }, 'csv', now))
    expect(csv).toBe(
      'timestamp,level,project,release,environment,trace_id,body,attributes\r\n' +
        '2026-10-26T11:59:00.000Z,error,pocketband,,,,"Export failed, ""disk full""","{""song"":42}"\r\n',
    )
    const lines = await read(await exportLogs(db, { query: '', window: { range: '24h' } }, 'jsonl', now))
    expect(
      lines
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l).body),
    ).toEqual(['Export failed, "disk full"', 'Saved'])
    expect(JSON.parse(lines.split('\n')[0]).attributes).toEqual({ song: 42 })
  })
})
