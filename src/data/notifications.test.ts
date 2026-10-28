import { describe, expect, it, vi } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { addToEveryRoute } from './notifications'

vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }))

describe('addToEveryRoute', () => {
  it('adds the channel to each route once, keeping the others', async () => {
    const db = sqliteD1()
    db.sqlite.exec(
      `INSERT INTO routes (id, kinds, channel_ids, created_at) VALUES (1, '["new"]', '[1]', 0), (2, '["new"]', '[1,2]', 0)`,
    )
    await addToEveryRoute(db, 2)
    await addToEveryRoute(db, 2)
    const rows = db.sqlite.prepare('SELECT channel_ids FROM routes ORDER BY id').all()
    expect(rows.map((r) => JSON.parse(r.channel_ids as string))).toEqual([
      [1, 2],
      [1, 2],
    ])
  })
})
