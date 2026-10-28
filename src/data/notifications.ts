// Notification settings: channels (where to), routes (what goes where), and a test send through a route.
import { type Channel, send, type TelegramConfig } from '../notify/channels'
import { mailerOf } from '../notify/email'
import type { MetricAlert } from '../notify/metrics'
import { channelIds, type Notice, type Route } from '../notify/notice'

export type ChannelInput = Omit<Channel, 'id'> & { id?: number }
export type RouteInput = Omit<Route, 'id'> & { id?: number }

export type MetricAlertInput = Pick<
  MetricAlert,
  'project_id' | 'name' | 'metric' | 'query' | 'window_hours' | 'direction' | 'warning' | 'critical'
> & { id?: number }

export async function settings(db: D1Database) {
  const [channels, routes, metricAlerts] = await db.batch<Record<string, unknown>>([
    db.prepare('SELECT * FROM channels ORDER BY name'),
    db.prepare('SELECT * FROM routes ORDER BY project_id IS NOT NULL, id'),
    db.prepare('SELECT * FROM metric_alerts ORDER BY name, id'),
  ])
  return {
    channels: channels.results as Channel[],
    routes: routes.results as Route[],
    metricAlerts: metricAlerts.results as MetricAlert[],
  }
}

/** Saving starts an alert again from ok: its next read alerts if it's still past a value */
export async function saveMetricAlert(db: D1Database, a: MetricAlertInput, by: string, now: number) {
  const values = [a.project_id, a.name, a.metric, a.query, a.window_hours, a.direction, a.warning, a.critical]
  if (a.id) {
    await db
      .prepare(
        `UPDATE metric_alerts SET project_id = ?, name = ?, metric = ?, query = ?, window_hours = ?, direction = ?,
           warning = ?, critical = ?, state = 'ok', value = NULL, changed_at = NULL WHERE id = ?`,
      )
      .bind(...values, a.id)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO metric_alerts (project_id, name, metric, query, window_hours, direction, warning, critical, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...values, by, now)
      .run()
  }
}

export const deleteMetricAlert = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM metric_alerts WHERE id = ?').bind(id).run()

export async function saveChannel(db: D1Database, c: ChannelInput, now: number) {
  if (c.id) {
    await db
      .prepare(
        'UPDATE channels SET kind = ?, name = ?, config = ?, quiet_from = ?, quiet_to = ?, quiet_zone = ? WHERE id = ?',
      )
      .bind(c.kind, c.name, c.config, c.quiet_from, c.quiet_to, c.quiet_zone, c.id)
      .run()
  } else {
    await db
      .prepare(
        'INSERT INTO channels (kind, name, config, quiet_from, quiet_to, quiet_zone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(c.kind, c.name, c.config, c.quiet_from, c.quiet_to, c.quiet_zone, now)
      .run()
  }
}

export const channelOf = (db: D1Database, id: number) =>
  db.prepare('SELECT * FROM channels WHERE id = ?').bind(id).first<Channel>()

export const deleteChannel = (db: D1Database, id: number) =>
  db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run()

/** Every Telegram channel's id and settings: a bot's channels share its one webhook and its secret */
export async function telegramChannels(db: D1Database) {
  const { results } = await db
    .prepare("SELECT id, config FROM channels WHERE kind = 'telegram'")
    .all<{ id: number; config: string }>()
  return results.map((r) => ({ id: r.id, ...(JSON.parse(r.config) as TelegramConfig) }))
}

export async function saveRoute(db: D1Database, r: RouteInput, now: number) {
  const values = [
    r.project_id,
    r.kinds,
    r.levels,
    r.environments,
    r.thresholds,
    r.channel_ids,
    r.frequency ?? null,
    r.releases ?? null,
    r.query ?? null,
    r.interval_minutes ?? 0,
  ]
  if (r.id) {
    await db
      .prepare(
        `UPDATE routes SET project_id = ?, kinds = ?, levels = ?, environments = ?, thresholds = ?, channel_ids = ?,
           frequency = ?, releases = ?, query = ?, interval_minutes = ? WHERE id = ?`,
      )
      .bind(...values, r.id)
      .run()
  } else {
    await db
      .prepare(
        `INSERT INTO routes (project_id, kinds, levels, environments, thresholds, channel_ids, frequency, releases, query,
           interval_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return sendTest(env, channels, origin)
}

/** The same through one channel, routes or not */
export async function testChannel(
  env: { DB: D1Database; EMAIL?: SendEmail; EMAIL_FROM?: string },
  channelId: number,
  origin: string,
) {
  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(channelId).first<Channel>()
  return sendTest(env, channel ? [channel] : [], origin)
}

function sendTest(
  env: { DB: D1Database; EMAIL?: SendEmail; EMAIL_FROM?: string },
  channels: Channel[],
  origin: string,
) {
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
        await send(c, notice, mailer, env.EMAIL_FROM || undefined, env.DB)
        return { channel: c.name, ok: true as const }
      } catch (error) {
        return { channel: c.name, ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )
}
