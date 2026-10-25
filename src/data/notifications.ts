// Notification settings: channels (where to), routes (what goes where), and a test send through a route.
import { type Channel, send } from '../notify/channels'
import { mailerOf } from '../notify/email'
import { channelIds, type Notice, type Route } from '../notify/notice'

export type ChannelInput = Omit<Channel, 'id'> & { id?: number }
export type RouteInput = Omit<Route, 'id'> & { id?: number }

export async function settings(db: D1Database) {
  const [channels, routes] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM channels ORDER BY name'),
    db.prepare('SELECT * FROM routes ORDER BY project_id IS NOT NULL, id'),
  ])
  return { channels: channels.results as Channel[], routes: routes.results as Route[] }
}

export async function saveChannel(db: D1Database, c: ChannelInput, now: number) {
  if (c.id) {
    await db
      .prepare('UPDATE channels SET kind = ?, name = ?, config = ?, quiet_from = ?, quiet_to = ? WHERE id = ?')
      .bind(c.kind, c.name, c.config, c.quiet_from, c.quiet_to, c.id)
      .run()
  } else {
    await db
      .prepare('INSERT INTO channels (kind, name, config, quiet_from, quiet_to, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(c.kind, c.name, c.config, c.quiet_from, c.quiet_to, now)
      .run()
  }
}

export const deleteChannel = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run()

export async function saveRoute(db: D1Database, r: RouteInput, now: number) {
  const values = [r.project_id, r.kinds, r.levels, r.environments, r.thresholds, r.channel_ids]
  if (r.id) {
    await db
      .prepare(
        'UPDATE routes SET project_id = ?, kinds = ?, levels = ?, environments = ?, thresholds = ?, channel_ids = ? WHERE id = ?',
      )
      .bind(...values, r.id)
      .run()
  } else {
    await db
      .prepare(
        'INSERT INTO routes (project_id, kinds, levels, environments, thresholds, channel_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(...values, now)
      .run()
  }
}

export const deleteRoute = (db: D1Database, id: number) => db.prepare('DELETE FROM routes WHERE id = ?').bind(id).run()

/** Sends a made-up notice through each of a route's channels, now (quiet hours or not); says how each went */
export async function testRoute(
  env: { DB: D1Database; EMAIL?: SendEmail; EMAIL_FROM?: string },
  routeId: number,
  origin: string,
) {
  const route = await env.DB.prepare('SELECT * FROM routes WHERE id = ?').bind(routeId).first<Route>()
  if (!route) return []
  const ids = channelIds(route)
  const channels = ids.length
    ? (
        await env.DB.prepare(`SELECT * FROM channels WHERE id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids)
          .all<Channel>()
      ).results
    : []
  const notice: Notice = {
    kind: 'new',
    project: { id: 0, slug: 'test', name: 'crashyard' },
    issue: { id: 0, title: 'A test from crashyard', culprit: 'notifications', level: 'info', count: 1 },
    event: { level: 'info', environment: 'production', release: 'test' },
    url: `${origin}/notifications`,
  }
  const mailer = mailerOf(env.EMAIL)
  return Promise.all(
    channels.map(async (c) => {
      try {
        await send(c, notice, mailer, env.EMAIL_FROM || undefined)
        return { channel: c.name, ok: true as const }
      } catch (error) {
        return { channel: c.name, ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}
