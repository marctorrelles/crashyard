// A project's status page: the uptime checks chosen for it, and what the team posts there, incidents, notices and
// maintenance, each a post with its updates and the checks it affects (0027, 0028); the page's look and its own domain
const DAY = 86_400_000

/** The page's own look (`projects.status_page`), each part optional */
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

/** The project's posts still open or ended in the last 30 days, newest first, each with its updates, newest first */
async function readPosts(db: D1Database, projectId: number, now: number) {
  const posts = (
    await db
      .prepare(
        `SELECT id, title, impact, starts_at, ends_at, resolved_at, created_at FROM status_posts
         WHERE project_id = ?
           AND COALESCE(resolved_at, CASE impact WHEN 'maintenance' THEN ends_at END, ?) >= ?
         ORDER BY COALESCE(starts_at, created_at) DESC LIMIT 50`,
      )
      .bind(projectId, now, now - 30 * DAY)
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
  projectId: number,
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
      `INSERT INTO status_posts (project_id, title, impact, starts_at, ends_at, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(projectId, post.title, post.impact, post.starts, post.ends, post.state === 'resolved' ? now : null, now)
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
  db
    .prepare(
      'SELECT p.id, p.impact, p.project_id, pr.slug FROM status_posts p JOIN projects pr ON pr.id = p.project_id WHERE p.id = ?',
    )
    .bind(id)
    .first<{ id: number; impact: Impact; project_id: number; slug: string }>()

// The post's affected checks: only uptime checks of its own project
const affects = (db: D1Database, postId: number, monitors: number[]) =>
  db
    .prepare(
      `INSERT INTO status_post_monitors (post_id, monitor_id)
       SELECT p.id, m.id FROM status_posts p JOIN monitors m ON m.project_id = p.project_id AND m.kind = 'uptime'
       WHERE p.id = ? AND m.id IN (SELECT value FROM json_each(?))`,
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

/** The project's uptime checks, whether each is on the page or not */
export const checksOf = async (db: D1Database, projectId: number) =>
  (
    await db
      .prepare("SELECT id, name, status, public FROM monitors WHERE project_id = ? AND kind = 'uptime' ORDER BY name")
      .bind(projectId)
      .all<{ id: number; name: string; status: string; public: number }>()
  ).results

export const deletePost = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM status_posts WHERE id = ?').bind(id).run()

/**
 * A project's public status page: its uptime checks shown on it, each with its state, its days up over the last 30
 * (UTC) and its incidents then, and the posts. Only what the page shows leaves here: names, times and what was
 * posted, never a URL, config, why a check failed or who posted. Null when the project shows nothing, the same as
 * when there's no such project.
 */
export async function statusPage(db: D1Database, slug: string, now: number) {
  const project = await db
    .prepare('SELECT id, name, status_page FROM projects WHERE slug = ?')
    .bind(slug)
    .first<{ id: number; name: string; status_page: string | null }>()
  if (!project) return null
  const since = Math.floor(now / DAY) * DAY - 29 * DAY
  const [[checks, days, incidents], posts] = await Promise.all([
    db.batch<Record<string, number | string | null>>([
      db
        .prepare(
          "SELECT id, name, status FROM monitors WHERE project_id = ? AND public = 1 AND kind = 'uptime' ORDER BY name",
        )
        .bind(project.id),
      db
        .prepare(
          `SELECT r.monitor_id, r.at / ${DAY} AS day, SUM(r.ok) AS up, COUNT(*) AS checks
           FROM uptime_results r JOIN monitors m ON m.id = r.monitor_id
           WHERE m.project_id = ? AND m.public = 1 AND m.kind = 'uptime' AND r.at >= ? GROUP BY r.monitor_id, day`,
        )
        .bind(project.id, since),
      db
        .prepare(
          `SELECT i.monitor_id, i.opened_at, i.closed_at FROM incidents i JOIN monitors m ON m.id = i.monitor_id
           WHERE m.project_id = ? AND m.public = 1 AND m.kind = 'uptime' AND (i.closed_at IS NULL OR i.closed_at >= ?)
           ORDER BY i.opened_at DESC LIMIT 50`,
        )
        .bind(project.id, since),
    ]),
    readPosts(db, project.id, now),
  ])
  if (!checks.results.length && !posts.length) return null
  const nameOf = new Map(checks.results.map((c) => [c.id as number, c.name as string]))
  // A check's worst open post: an outage, then some services affected, then maintenance going on; notices change nothing
  const affectedBy = (id: number) =>
    (['major', 'minor', 'maintenance'] as const).find((impact) =>
      posts.some((p) => p.impact === impact && (p.phase === 'open' || p.phase === 'ongoing') && p.affects.includes(id)),
    ) ?? null
  return {
    name: project.name,
    branding: parseBranding(project.status_page),
    now,
    checks: checks.results.map((c) => {
      const mine = days.results.filter((d) => d.monitor_id === c.id)
      const up = mine.reduce((n, d) => n + (d.up as number), 0)
      const all = mine.reduce((n, d) => n + (d.checks as number), 0)
      return {
        name: c.name as string,
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

/** The project whose status page a hostname opens, read at most once a minute per isolate */
export async function slugOfDomain(db: D1Database, host: string, now: number) {
  if (!domains || now - domains.at > 60_000) {
    const rows = (
      await db
        .prepare('SELECT status_domain, slug FROM projects WHERE status_domain IS NOT NULL')
        .all<{ status_domain: string; slug: string }>()
    ).results
    domains = { at: now, slugs: new Map(rows.map((r) => [r.status_domain, r.slug])) }
  }
  return domains.slugs.get(host.toLowerCase())
}
