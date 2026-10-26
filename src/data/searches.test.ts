import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { deleteSearch, listSavedSearches, pinSearch, saveSearch } from './searches'

describe('saved searches', () => {
  it('lists the viewer’s own and the shared ones, their pinned one first, one pinned a page', async () => {
    const db = sqliteD1()
    const a = await saveSearch(db, 'a@x', { page: 'issues', name: 'Fatal', query: 'level:fatal', shared: false }, 1)
    const b = await saveSearch(db, 'a@x', { page: 'issues', name: 'iOS', query: 'os:iOS', shared: true }, 2)
    await saveSearch(db, 'b@x', { page: 'issues', name: 'Bob’s', query: 'is:new', shared: false }, 3)
    const shared = await saveSearch(
      db,
      'b@x',
      { page: 'issues', name: 'Android', query: 'os:Android', shared: true },
      4,
    )
    await saveSearch(db, 'a@x', { page: 'logs', name: 'Errors', query: 'level:error', shared: false }, 5)
    await pinSearch(db, 'a@x', a, true)
    await pinSearch(db, 'a@x', b, true)
    const mine = await listSavedSearches(db, 'a@x', 'issues')
    expect(mine.map((s) => [s.name, s.pinned, s.mine])).toEqual([
      ['iOS', true, true],
      ['Android', false, false],
      ['Fatal', false, true],
    ])
    // Someone else's shared search can be read, not pinned or deleted
    await expect(pinSearch(db, 'a@x', shared, true)).rejects.toThrow('Only the person')
    await expect(deleteSearch(db, 'a@x', shared)).rejects.toThrow('Only the person')
    await deleteSearch(db, 'a@x', b)
    expect((await listSavedSearches(db, 'a@x', 'issues')).map((s) => s.name)).toEqual(['Android', 'Fatal'])
    expect((await listSavedSearches(db, 'b@x', 'issues')).map((s) => s.name)).toEqual(['Android', 'Bob’s'])
  })
})
