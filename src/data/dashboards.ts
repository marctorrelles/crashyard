// Dashboards: a name and its widgets (src/data/widgets.ts), shared by everyone signed in, with the widget lists it
// had before its last 10 saves to look back on and restore.
import { MAX_WIDGETS, parseWidgets, readWidgets, type Widget } from './widgets'

export type Dashboard = { id: number; name: string; widgets: Widget[]; updated: number; updated_by: string }
/** A widget list a dashboard had before a save: as it was stored, who saved it and when */
type Revision = { widgets: unknown; by: string; at: number }
export const MAX_REVISIONS = 10

export async function listDashboards(db: D1Database) {
  return (
    await db
      .prepare(
        `SELECT id, name, CASE WHEN json_valid(widgets) THEN json_array_length(widgets) END AS widgets, updated,
         updated_by FROM dashboards ORDER BY updated DESC`,
      )
      .all<{ id: number; name: string; widgets: number | null; updated: number; updated_by: string }>()
  ).results
}

export async function getDashboard(db: D1Database, id: number): Promise<Dashboard | null> {
  const row = await db
    .prepare('SELECT id, name, widgets, updated, updated_by FROM dashboards WHERE id = ?')
    .bind(id)
    .first<Omit<Dashboard, 'widgets'> & { widgets: string }>()
  return row && { ...row, widgets: readWidgets(row.widgets) }
}

/**
 * A new dashboard (no `id`) or a whole one written over, in schema v2; its id. Over one, the widget list it had goes
 * first in `revisions` (10 at most) when the widgets change, with who saved it and when
 */
export async function saveDashboard(
  db: D1Database,
  d: { id?: number; name: string; widgets: Widget[] },
  by: string,
  now: number,
) {
  const widgets = JSON.stringify(d.widgets)
  if (d.id === undefined) {
    const row = await db
      .prepare('INSERT INTO dashboards (name, widgets, updated, updated_by) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(d.name, widgets, now, by)
      .first<{ id: number }>()
    return row!.id
  }
  const old = await db
    .prepare('SELECT widgets, updated, updated_by, revisions FROM dashboards WHERE id = ?')
    .bind(d.id)
    .first<{ widgets: string; updated: number; updated_by: string; revisions: string }>()
  if (!old) throw new Error('This dashboard no longer exists.')
  let revisions = revisionsOf(old.revisions)
  if (old.widgets !== widgets) {
    let before: unknown = old.widgets
    try {
      before = JSON.parse(old.widgets)
    } catch {
      // Kept as the text it was: it reads back as a placeholder
    }
    revisions = [{ widgets: before, by: old.updated_by, at: old.updated }, ...revisions].slice(0, MAX_REVISIONS)
  }
  // Written only over the row read, so two saves at once can't drop each other's revision
  const row = await db
    .prepare(
      `UPDATE dashboards SET name = ?, widgets = ?, updated = ?, updated_by = ?, revisions = ?
       WHERE id = ? AND updated = ? RETURNING id`,
    )
    .bind(d.name, widgets, now, by, JSON.stringify(revisions), d.id, old.updated)
    .first<{ id: number }>()
  if (!row) throw new Error('Someone saved this dashboard just now. Open it again to see their changes.')
  return row.id
}

const revisionsOf = (text: string): Revision[] => {
  try {
    const list: unknown = JSON.parse(text)
    return Array.isArray(list) ? (list as Revision[]) : []
  } catch {
    return []
  }
}

/** A dashboard's revisions, newest first: when, who, and how many widgets */
export async function dashboardHistory(db: D1Database, id: number) {
  const row = await db.prepare('SELECT revisions FROM dashboards WHERE id = ?').bind(id).first<{ revisions: string }>()
  return revisionsOf(row?.revisions ?? '[]').map((r, index) => ({
    index,
    by: r.by,
    at: r.at,
    widgets: Array.isArray(r.widgets) ? r.widgets.length : null,
  }))
}

/** The widgets of one revision, read as stored ones are (v1 upgraded, a bad one a placeholder) */
export async function revisionWidgets(db: D1Database, id: number, index: number) {
  const row = await db.prepare('SELECT revisions FROM dashboards WHERE id = ?').bind(id).first<{ revisions: string }>()
  const revision = revisionsOf(row?.revisions ?? '[]')[index]
  if (!revision) throw new Error('That version is no longer kept.')
  return readWidgets(typeof revision.widgets === 'string' ? revision.widgets : JSON.stringify(revision.widgets))
}

/** One widget added at the end of a dashboard (from the logs page), saved as a whole */
export async function addWidget(db: D1Database, id: number, widget: Widget, by: string, now: number) {
  const d = await getDashboard(db, id)
  if (!d) throw new Error('This dashboard no longer exists.')
  if (d.widgets.length >= MAX_WIDGETS) throw new Error(`${d.name} holds ${MAX_WIDGETS} widgets already.`)
  if (d.widgets.some((w) => w.invalid))
    throw new Error(`Remove or redo the widgets of ${d.name} that can’t be read first.`)
  return saveDashboard(db, { id, name: d.name, widgets: parseWidgets([...d.widgets, widget]) }, by, now)
}

export async function deleteDashboard(db: D1Database, id: number) {
  await db.prepare('DELETE FROM dashboards WHERE id = ?').bind(id).run()
}

/**
 * The filter bar's choices: the environments and releases events came with in the last 30 days, by how many, 50
 * each at most (`event_hours_hour`, or a project's `event_hours_project_hour`)
 */
export async function filterOptions(db: D1Database, projectId: number | undefined, now: number) {
  const since = now - 30 * 864e5
  const project = projectId ? ' AND project_id = ?' : ''
  const of = (column: 'environment' | 'release') =>
    db
      .prepare(
        `SELECT ${column} AS value FROM event_hours WHERE hour >= ?${project} AND ${column} != ''
         GROUP BY ${column} ORDER BY SUM(count) DESC LIMIT 50`,
      )
      .bind(since, ...(projectId ? [projectId] : []))
  const [environments, releases] = await db.batch<{ value: string }>([of('environment'), of('release')])
  return {
    environments: environments.results.map((r) => r.value),
    releases: releases.results.map((r) => r.value),
  }
}
