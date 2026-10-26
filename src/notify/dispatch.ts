// Sending notices: each through the routes that take it, to their channels, now or after the channel's quiet hours.
import { type Channel, isQuiet, send } from './channels'
import { mailerOf } from './email'
import { channelIds, type Notice, routeTakes, type Route, thresholdFor } from './notice'

export type NotifyEnv = { DB: D1Database; EMAIL?: SendEmail; EMAIL_FROM?: string }

/** A send a channel refused, for Settings, Health; never throws, so one failure doesn't stop the rest */
async function failed(db: D1Database, channel: Channel, notice: Notice, error: unknown, now: number) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`notify: ${channel.kind} channel ${channel.name}: ${message}`)
  await db
    .prepare('INSERT INTO notification_failures (channel_id, kind, error, at) VALUES (?, ?, ?, ?)')
    .bind(channel.id, notice.kind, message.slice(0, 500), now)
    .run()
    .catch(() => {})
}

/** The hourly cron: failures older than 30 days */
export const pruneFailures = (db: D1Database, now: number) =>
  db
    .prepare('DELETE FROM notification_failures WHERE at < ?')
    .bind(now - 30 * 864e5)
    .run()

export async function dispatch(env: NotifyEnv, notices: Notice[], now = Date.now()): Promise<void> {
  if (!notices.length) return
  const routes = (await env.DB.prepare('SELECT * FROM routes').all<Route>()).results
  const channels = new Map(
    (await env.DB.prepare('SELECT * FROM channels').all<Channel>()).results.map((c) => [c.id, c]),
  )
  const mailer = mailerOf(env.EMAIL)
  for (const candidate of notices) {
    // A channel hears of a notice once, through the first route that takes it
    const targets = new Map<number, Notice>()
    for (const route of routes.filter((r) => routeTakes(r, candidate))) {
      const notice =
        candidate.kind === 'threshold' ? { ...candidate, threshold: thresholdFor(route, candidate) } : candidate
      for (const id of channelIds(route)) if (!targets.has(id)) targets.set(id, notice)
    }
    for (const [id, notice] of targets) {
      const channel = channels.get(id)
      if (!channel) continue
      if (isQuiet(channel, now)) {
        await env.DB.prepare('INSERT INTO held_notifications (channel_id, payload, at) VALUES (?, ?, ?)')
          .bind(id, JSON.stringify(notice), now)
          .run()
        continue
      }
      try {
        await send(channel, notice, mailer, env.EMAIL_FROM || undefined)
      } catch (error) {
        await failed(env.DB, channel, notice, error, now)
      }
    }
  }
}

/** After quiet hours: what each channel held, sent as one notice (the newest, saying how many came with it) */
export async function flushHeld(env: NotifyEnv, now = Date.now()): Promise<void> {
  const held = (
    await env.DB.prepare('SELECT * FROM held_notifications ORDER BY at').all<{
      id: number
      channel_id: number
      payload: string
    }>()
  ).results
  if (!held.length) return
  const channels = new Map(
    (await env.DB.prepare('SELECT * FROM channels').all<Channel>()).results.map((c) => [c.id, c]),
  )
  const mailer = mailerOf(env.EMAIL)
  const byChannel = Map.groupBy(held, (h) => h.channel_id)
  for (const [id, rows] of byChannel) {
    const channel = channels.get(id)
    if (channel && isQuiet(channel, now)) continue
    if (channel) {
      const last = JSON.parse(rows.at(-1)!.payload) as Notice
      const notice =
        rows.length > 1
          ? {
              ...last,
              issue: { ...last.issue, title: `${last.issue.title} (and ${rows.length - 1} more while quiet)` },
            }
          : last
      try {
        await send(channel, notice, mailer, env.EMAIL_FROM || undefined)
      } catch (error) {
        await failed(env.DB, channel, notice, error, now)
      }
    }
    await env.DB.prepare(`DELETE FROM held_notifications WHERE id IN (${rows.map(() => '?').join(',')})`)
      .bind(...rows.map((r) => r.id))
      .run()
  }
}
