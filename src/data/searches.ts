// Saved searches: a named query on the issues, logs or explore page. Each person sees their own and the shared ones,
// and their pinned one (one a page) opens by default.
export const PAGES = ['issues', 'logs', 'explore'] as const
export type SearchPage = (typeof PAGES)[number]
export type SavedSearch = {
  id: number
  name: string
  query: string
  pinned: boolean
  shared: boolean
  mine: boolean
  email: string
}

/** The viewer's own searches and everyone's shared ones for a page: their pinned one first, then by name */
export async function listSavedSearches(db: D1Database, email: string, page: SearchPage): Promise<SavedSearch[]> {
  const rows = (
    await db
      .prepare(
        `SELECT id, email, name, query, pinned, shared FROM saved_searches
         WHERE page = ? AND (email = ? OR shared = 1)
         ORDER BY email = ? AND pinned = 1 DESC, name COLLATE NOCASE, id LIMIT 100`,
      )
      .bind(page, email, email)
      .all<{ id: number; email: string; name: string; query: string; pinned: number; shared: number }>()
  ).results
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    query: r.query,
    // A pin is its owner's: someone else's shared search isn't pinned for the viewer
    pinned: r.email === email && r.pinned === 1,
    shared: r.shared === 1,
    mine: r.email === email,
  }))
}

export async function saveSearch(
  db: D1Database,
  email: string,
  s: { page: SearchPage; name: string; query: string; shared: boolean },
  now: number,
) {
  const row = await db
    .prepare(
      'INSERT INTO saved_searches (email, page, name, query, shared, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    )
    .bind(email, s.page, s.name, s.query, s.shared ? 1 : 0, now)
    .first<{ id: number }>()
  return row!.id
}

/** Pins one of the viewer's own searches, unpinning their others of the page; or unpins it */
export async function pinSearch(db: D1Database, email: string, id: number, pinned: boolean) {
  const row = await db
    .prepare('SELECT page FROM saved_searches WHERE id = ? AND email = ?')
    .bind(id, email)
    .first<{ page: string }>()
  if (!row) throw new Error('Only the person who saved a search can pin it.')
  await db.batch([
    db.prepare('UPDATE saved_searches SET pinned = 0 WHERE email = ? AND page = ?').bind(email, row.page),
    db.prepare('UPDATE saved_searches SET pinned = ? WHERE id = ? AND email = ?').bind(pinned ? 1 : 0, id, email),
  ])
}

/** Deletes one of the viewer's own searches; someone else's, shared or not, stays */
export async function deleteSearch(db: D1Database, email: string, id: number) {
  const r = await db.prepare('DELETE FROM saved_searches WHERE id = ? AND email = ?').bind(id, email).run()
  if (!r.meta.changes) throw new Error('Only the person who saved a search can delete it.')
}
