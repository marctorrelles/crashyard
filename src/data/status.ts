// Status pages (0030): each shows the uptime checks it picks, from any projects, and what the team posts there,
// incidents, notices and maintenance, each a post with its updates and the checks it affects; its look and its own
// domain
const DAY = 86_400_000

/** The page's own look (`status_pages.branding`), each part optional */
export type Branding = { title?: string; description?: string; logo?: string; color?: string; website?: string }

export function parseBranding(json: string | null): Branding {
  try {
    const b = JSON.parse(json ?? '{}')
    return b && typeof b === 'object' && !Array.isArray(b) ? b : {}
  } catch {
    return {}
  }
}

export type Impact = 'notice' | 'minor' | 'major' | 'maintenance'
export type PostState = 'investigating' | 'identified' | 'monitoring' | 'update' | 'resolved'

export const IMPACTS: Record<Impact, string> = {
  minor: 'Some services affected',
  major: 'Major outage',
  notice: 'Notice',
  maintenance: 'Maintenance',
}

const INCIDENT: PostState[] = ['investigating', 'identified', 'monitoring', 'resolved']
/** The states an update can take, by the post's impact, the first the one a new post starts with */
export const STATES_FOR: Record<Impact, PostState[]> = {
  minor: INCIDENT,
  major: INCIDENT,
  notice: ['update', 'resolved'],
  maintenance: ['update', 'resolved'],
}

export const stateLabel = (state: PostState, impact: Impact) =>
  state === 'resolved' && impact === 'maintenance'
    ? 'Completed'
    : {
        investigating: 'Investigating',
        identified: 'Identified',
        monitoring: 'Monitoring',
        update: 'Update',
        resolved: 'Resolved',
      }[state]

/** Where a post stands: open (an incident or notice), upcoming or ongoing (maintenance), or past */
export type Phase = 'open' | 'upcoming' | 'ongoing' | 'past'

type PostRow = {
  id: number
  title: string
  impact: Impact
  starts_at: number | null
  ends_at: number | null
  resolved_at: number | null
  created_at: number
}
type UpdateRow = { post_id: number; state: PostState; message: string; by: string; at: number }

const ended = (p: PostRow) => p.resolved_at ?? (p.impact === 'maintenance' ? p.ends_at : null)

function phaseOf(p: PostRow, now: number): Phase {
  const end = ended(p)
  if (end !== null && end <= now) return 'past'
  if (p.impact !== 'maintenance') return 'open'
  return p.starts_at! > now ? 'upcoming' : 'ongoing'
}

/** The page's posts still open or ended in the last 30 days, newest first, each with its updates, newest first */
async function readPosts(db: D1Database, pageId: number, now: number) {
  const posts = (
    await db
      .prepare(
        `SELECT id, title, impact, starts_at, ends_at, resolved_at, created_at FROM status_posts
         WHERE page_id = ?
           AND COALESCE(resolved_at, CASE impact WHEN 'maintenance' THEN ends_at END, ?) >= ?
         ORDER BY COALESCE(starts_at, created_at) DESC LIMIT 50`,
      )
      .bind(pageId, now, now - 30 * DAY)
      .all<PostRow>()
  ).results
  const updates = posts.length
    ? (
        await db
          .prepare(
            'SELECT post_id, state, message, by, at FROM status_updates WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id DESC',
          )
          .bind(JSON.stringify(posts.map((p) => p.id)))
          .all<UpdateRow>()
      ).results
    : []
  const affected = posts.length
    ? (
        await db
          .prepare(
            'SELECT post_id, monitor_id FROM status_post_monitors WHERE post_id IN (SELECT value FROM json_each(?))',
          )
          .bind(JSON.stringify(posts.map((p) => p.id)))
          .all<{ post_id: number; monitor_id: number }>()
      ).results
    : []
  return posts.map((p) => ({
    id: p.id,
    title: p.title,
    impact: p.impact,
    starts: p.starts_at,
    ends: p.ends_at,
    ended: ended(p),
    phase: phaseOf(p, now),
    affects: affected.filter((a) => a.post_id === p.id).map((a) => a.monitor_id),
    updates: updates
      .filter((u) => u.post_id === p.id)
      .map(({ state, message, by, at }) => ({ state, message, by, at })),
  }))
}

/** The posts as the team sees them, with who posted each update */
export const postsOf = readPosts

/** A post and its first update; a post made resolved starts resolved */
export async function createPost(
  db: D1Database,
  pageId: number,
  post: {
    title: string
    impact: Impact
    state: PostState
    message: string
    starts: number | null
    ends: number | null
    monitors: number[]
  },
  by: string,
  now: number,
) {
  const row = await db
    .prepare(
      `INSERT INTO status_posts (page_id, title, impact, starts_at, ends_at, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(pageId, post.title, post.impact, post.starts, post.ends, post.state === 'resolved' ? now : null, now)
    .first<{ id: number }>()
  await db.batch([
    db
      .prepare('INSERT INTO status_updates (post_id, state, message, by, at) VALUES (?, ?, ?, ?, ?)')
      .bind(row!.id, post.state, post.message, by, now),
    affects(db, row!.id, post.monitors),
  ])
  return row!.id
}

export const postOf = (db: D1Database, id: number) =>
  db.prepare('SELECT id, impact FROM status_posts WHERE id = ?').bind(id).first<{ id: number; impact: Impact }>()

// The post's affected checks: only those on its page
const affects = (db: D1Database, postId: number, monitors: number[]) =>
  db
    .prepare(
      `INSERT INTO status_post_monitors (post_id, monitor_id)
       SELECT p.id, s.monitor_id FROM status_posts p JOIN status_page_monitors s ON s.page_id = p.page_id
       WHERE p.id = ? AND s.monitor_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(postId, JSON.stringify(monitors))

/** An update to a post: Resolved closes it, any other state opens it again; `monitors`, when given, are what it affects now */
export async function addUpdate(
  db: D1Database,
  postId: number,
  state: PostState,
  message: string,
  by: string,
  now: number,
  monitors?: number[],
) {
  await db.batch([
    ...(monitors
      ? [db.prepare('DELETE FROM status_post_monitors WHERE post_id = ?').bind(postId), affects(db, postId, monitors)]
      : []),
    db
      .prepare('INSERT INTO status_updates (post_id, state, message, by, at) VALUES (?, ?, ?, ?, ?)')
      .bind(postId, state, message, by, now),
    db.prepare('UPDATE status_posts SET resolved_at = ? WHERE id = ?').bind(state === 'resolved' ? now : null, postId),
  ])
}

/** Every project's uptime checks, by project, and whether each is on the page */
export const checksOf = async (db: D1Database, pageId: number) =>
  (
    await db
      .prepare(
        `SELECT m.id, m.name, m.status, p.name AS project,
           EXISTS (SELECT 1 FROM status_page_monitors s WHERE s.page_id = ? AND s.monitor_id = m.id) AS shown
         FROM monitors m JOIN projects p ON p.id = m.project_id WHERE m.kind = 'uptime' ORDER BY p.name, m.name`,
      )
      .bind(pageId)
      .all<{ id: number; name: string; status: string; project: string; shown: number }>()
  ).results

/** Every status page, for Monitors: its domain, the checks on it, and its posts not yet ended */
export const pagesOf = async (db: D1Database, now: number) =>
  (
    await db
      .prepare(
        `SELECT g.id, g.slug, g.name, g.domain,
           (SELECT COUNT(*) FROM status_page_monitors s WHERE s.page_id = g.id) AS shown,
           (SELECT COUNT(*) FROM status_posts s WHERE s.page_id = g.id
              AND COALESCE(s.resolved_at, CASE WHEN s.impact = 'maintenance' THEN s.ends_at END, ? + 1) > ?) AS open
         FROM status_pages g ORDER BY g.name`,
      )
      .bind(now, now)
      .all<{ id: number; slug: string; name: string; domain: string | null; shown: number; open: number }>()
  ).results

export type PageRow = {
  id: number
  slug: string
  name: string
  branding: string | null
  domain: string | null
  created_at: number
}

export const pageOf = (db: D1Database, slug: string) =>
  db.prepare('SELECT * FROM status_pages WHERE slug = ?').bind(slug).first<PageRow>()

/** The status pages a check is on, for its monitor page */
export const pagesShowing = async (db: D1Database, monitorId: number) =>
  (
    await db
      .prepare(
        `SELECT g.slug, g.name FROM status_pages g JOIN status_page_monitors s ON s.page_id = g.id
         WHERE s.monitor_id = ? ORDER BY g.name`,
      )
      .bind(monitorId)
      .all<{ slug: string; name: string }>()
  ).results

/** An address made of a name: lowercase letters, numbers and dashes, `page` when nothing's left */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'page'

/** A new page named so, its slug made of the name, a number added while another page has it; its slug */
export async function createPage(db: D1Database, name: string, now: number) {
  const base = slugify(name)
  const taken = new Set(
    (
      await db
        .prepare("SELECT slug FROM status_pages WHERE slug = ? OR slug LIKE ? || '-%'")
        .bind(base, base)
        .all<{ slug: string }>()
    ).results.map((r) => r.slug),
  )
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  await db.prepare('INSERT INTO status_pages (slug, name, created_at) VALUES (?, ?, ?)').bind(slug, name, now).run()
  return slug
}

export type PageChange = Partial<Pick<PageRow, 'name' | 'slug' | 'branding' | 'domain'>>

/** Only the fields given change; a slug or domain another page has is refused */
export async function updatePage(db: D1Database, id: number, change: PageChange) {
  const fields = (['name', 'slug', 'branding', 'domain'] as const).filter((f) => change[f] !== undefined)
  if (!fields.length) return
  for (const [field, taken] of [
    ['slug', 'Another status page has that address. Pick a different one.'],
    ['domain', 'Another status page has that domain. Use a different one.'],
  ] as const)
    if (
      change[field] &&
      (await db.prepare(`SELECT 1 FROM status_pages WHERE ${field} = ? AND id != ?`).bind(change[field], id).first())
    )
      throw new Error(taken)
  await db
    .prepare(`UPDATE status_pages SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .bind(...fields.map((f) => change[f]), id)
    .run()
}

/** Shows an uptime check on the page, or takes it off */
export const setCheck = (db: D1Database, pageId: number, monitorId: number, on: boolean) =>
  on
    ? db
        .prepare(
          "INSERT OR IGNORE INTO status_page_monitors (page_id, monitor_id) SELECT ?, id FROM monitors WHERE id = ? AND kind = 'uptime'",
        )
        .bind(pageId, monitorId)
        .run()
    : db.prepare('DELETE FROM status_page_monitors WHERE page_id = ? AND monitor_id = ?').bind(pageId, monitorId).run()

/** Deletes the page with its posts; the checks stay */
export const deletePage = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM status_pages WHERE id = ?').bind(id).run()

export const deletePost = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM status_posts WHERE id = ?').bind(id).run()

/**
 * A public status page: the uptime checks on it, each with its project's name, its state, its days up over the last
 * 30 (UTC) and its incidents then, and the posts. Only what the page shows leaves here: names, times and what was
 * posted, never a URL, config, why a check failed or who posted. Null when the page shows nothing, the same as when
 * there's no such page.
 */
export async function statusPage(db: D1Database, slug: string, now: number) {
  const page = await db
    .prepare('SELECT id, name, branding FROM status_pages WHERE slug = ?')
    .bind(slug)
    .first<{ id: number; name: string; branding: string | null }>()
  if (!page) return null
  const since = Math.floor(now / DAY) * DAY - 29 * DAY
  const [[checks, days, incidents], posts] = await Promise.all([
    db.batch<Record<string, number | string | null>>([
      db
        .prepare(
          `SELECT m.id, m.name, m.status, p.name AS project FROM status_page_monitors s
           JOIN monitors m ON m.id = s.monitor_id JOIN projects p ON p.id = m.project_id
           WHERE s.page_id = ? ORDER BY p.name, m.name`,
        )
        .bind(page.id),
      db
        .prepare(
          `SELECT r.monitor_id, r.at / ${DAY} AS day, SUM(r.ok) AS up, COUNT(*) AS checks
           FROM uptime_results r JOIN status_page_monitors s ON s.monitor_id = r.monitor_id
           WHERE s.page_id = ? AND r.at >= ? GROUP BY r.monitor_id, day`,
        )
        .bind(page.id, since),
      db
        .prepare(
          `SELECT i.monitor_id, i.opened_at, i.closed_at FROM incidents i JOIN status_page_monitors s ON s.monitor_id = i.monitor_id
           WHERE s.page_id = ? AND (i.closed_at IS NULL OR i.closed_at >= ?)
           ORDER BY i.opened_at DESC LIMIT 50`,
        )
        .bind(page.id, since),
    ]),
    readPosts(db, page.id, now),
  ])
  if (!checks.results.length && !posts.length) return null
  const nameOf = new Map(checks.results.map((c) => [c.id as number, c.name as string]))
  // A check's worst open post: an outage, then some services affected, then maintenance going on; notices change nothing
  const affectedBy = (id: number) =>
    (['major', 'minor', 'maintenance'] as const).find((impact) =>
      posts.some((p) => p.impact === impact && (p.phase === 'open' || p.phase === 'ongoing') && p.affects.includes(id)),
    ) ?? null
  return {
    name: page.name,
    branding: parseBranding(page.branding),
    now,
    checks: checks.results.map((c) => {
      const mine = days.results.filter((d) => d.monitor_id === c.id)
      const up = mine.reduce((n, d) => n + (d.up as number), 0)
      const all = mine.reduce((n, d) => n + (d.checks as number), 0)
      return {
        name: c.name as string,
        project: c.project as string,
        status: c.status as 'pending' | 'ok' | 'failing' | 'paused',
        affected: affectedBy(c.id as number),
        uptime: all ? up / all : null,
        // The last 30 UTC days, oldest first: the share of checks that passed, null for a day without any
        days: Array.from({ length: 30 }, (_, i) => {
          const d = mine.find((r) => r.day === since / DAY + i)
          return { at: since + i * DAY, up: d ? (d.up as number) / (d.checks as number) : null }
        }),
      }
    }),
    incidents: incidents.results.map((i) => ({
      check: nameOf.get(i.monitor_id as number)!,
      opened: i.opened_at as number,
      closed: i.closed_at as number | null,
    })),
    // Only checks on the page are named; who posted never leaves
    posts: posts.map(({ updates, affects, ...p }) => ({
      ...p,
      affects: affects.flatMap((id) => nameOf.get(id) ?? []),
      updates: updates.map(({ by: _, ...u }) => u),
    })),
  }
}

let domains: { at: number; slugs: Map<string, string> } | undefined

/** The status page a hostname opens, read at most once a minute per isolate */
export async function slugOfDomain(db: D1Database, host: string, now: number) {
  if (!domains || now - domains.at > 60_000) {
    const rows = (
      await db
        .prepare('SELECT domain, slug FROM status_pages WHERE domain IS NOT NULL')
        .all<{ domain: string; slug: string }>()
    ).results
    domains = { at: now, slugs: new Map(rows.map((r) => [r.domain, r.slug])) }
  }
  return domains.slugs.get(host.toLowerCase())
}
