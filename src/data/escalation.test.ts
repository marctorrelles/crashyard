import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { checkEscalation, escalating, HISTORY } from './escalation'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 26, 12, 25)
const LAST = Date.UTC(2026, 9, 26, 11) // the hour just ended

/** A week of hours, oldest first, from a count per hour of the day */
const week = (perHour: (hourOfDay: number) => number) => Array.from({ length: HISTORY }, (_, i) => perHour(i % 24))

describe('escalation', () => {
  it('escalates an issue with 2 a day for a week and 40 in the last hour', () => {
    expect(escalating([...week((h) => (h === 9 || h === 17 ? 1 : 0)), 40])).toBe(true)
  })

  it('doesn’t for steady traffic, however busy, nor its usual peak', () => {
    expect(escalating([...week(() => 20), 20])).toBe(false)
    expect(escalating([...week((h) => (h === 18 ? 30 : 20)), 35])).toBe(false)
  })

  it('never escalates under 10 events in the hour', () => {
    expect(escalating([...week(() => 0), 9])).toBe(false)
    expect(escalating([...week(() => 0), 10])).toBe(true)
  })

  it('opens an issue ignored until it escalates, once, and leaves a young one be', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'pocketband', 'pocketband', 'k', 0);
      INSERT INTO issues (id, project_id, fingerprint, title, level, status, substatus, first_seen, last_seen, count)
        VALUES (1, 1, 'a', 'Audio engine crashed', 'fatal', 'ignored', 'until_escalating', ${NOW - 30 * 864e5}, ${NOW}, 54),
               (2, 1, 'b', 'Just appeared', 'error', 'unresolved', 'new', ${NOW - 2 * HOUR}, ${NOW}, 40),
               (3, 1, 'c', 'Ignored for good', 'error', 'ignored', 'for_good', ${NOW - 30 * 864e5}, ${NOW}, 40);
      INSERT INTO event_hours (project_id, issue_id, hour, level, release, environment, count) VALUES
        (1, 1, ${LAST - 50 * HOUR}, 'fatal', '1.0', 'production', 2),
        (1, 1, ${LAST}, 'fatal', '1.1', 'production', 38),
        (1, 1, ${LAST}, 'fatal', '1.0', 'production', 2),
        (1, 2, ${LAST}, 'error', '1.1', 'production', 40),
        (1, 3, ${LAST}, 'error', '1.1', 'production', 40);`)
    const [notice, ...rest] = await checkEscalation(db, 'https://crashyard.example.com', NOW)
    expect(rest).toEqual([])
    expect(notice).toMatchObject({
      kind: 'escalating',
      issue: { id: 1, title: 'Audio engine crashed' },
      event: { release: '1.1', environment: 'production', level: 'fatal' },
      rate: { count: 40 },
    })
    const status = (id: number) => db.sqlite.prepare('SELECT status, substatus FROM issues WHERE id = ?').get(id)
    expect(status(1)).toEqual({ status: 'unresolved', substatus: 'escalating' })
    expect(status(2)).toEqual({ status: 'unresolved', substatus: 'new' })
    expect(status(3)).toEqual({ status: 'ignored', substatus: 'for_good' })
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM issue_activity WHERE kind = 'escalating'").get()).toEqual({
      n: 1,
    })
    // Already escalating: not again; a week later without another, back to ongoing
    expect(await checkEscalation(db, '', NOW)).toEqual([])
    await checkEscalation(db, '', NOW + 8 * 864e5)
    expect(status(1)).toEqual({ status: 'unresolved', substatus: 'ongoing' })
  })
})
