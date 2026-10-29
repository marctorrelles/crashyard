// Sending notices: each through the routes that take it, to their channels, now or after the channel's quiet hours.
import { type Channel, isQuiet, send } from './channels'
import { mailerOf } from './email'
import { channelIds, ISSUE_KINDS, type Notice, routeTakes, type Route, thresholdFor } from './notice'
import { throttled } from './rules'

export type NotifyEnv = { DB: D1Database; EMAIL?: SendEmail; EMAIL_FROM?: string }

/** What a channel did with a notice, in `sent_notifications.deliveries` */
export type Delivery = { state: 'sent' | 'held' | 'failed'; error?: string }

/** A send a channel refused, for Settings, Health; never throws, so one failure doesn't stop the rest */
async function failed(db: D1Database, channel: Channel, notice: Notice, error: unknown, now: number) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
  console.error(`notify: ${channel.kind} channel ${channel.name}: ${message}`)
  await db
    .prepare('INSERT INTO notification_failures (channel_id, kind, error, at) VALUES (?, ?, ?, ?)')
    .bind(channel.id, notice.kind, message, now)
    .run()
    .catch(() => {})
  return { state: 'failed', error: message } satisfies Delivery
}

/** The hourly cron: failures and sent notifications older than 30 days */
export const pruneFailures = (db: D1Database, now: number) =>
  db.batch([
    db.prepare('DELETE FROM notification_failures WHERE at < ?').bind(now - 30 * 864e5),
    db.prepare('DELETE FROM sent_notifications WHERE at < ?').bind(now - 30 * 864e5),
  ])

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
      // A route's wait holds per issue, whatever the kind
      if (ISSUE_KINDS.has(candidate.kind) && (await throttled(env.DB, route, candidate.issue.id, now))) continue
      const notice =
        candidate.kind === 'threshold' ? { ...candidate, threshold: thresholdFor(route, candidate) } : candidate
      for (const id of channelIds(route)) if (!targets.has(id)) targets.set(id, notice)
    }
    const live = [...targets].filter(([id]) => channels.has(id))
    if (!live.length) continue
    // Its channels at once, each on its own: a slow one doesn't hold the others back (each send times out)
    const deliveries: [number, Delivery][] = await Promise.all(
      live.map(async ([id, notice]): Promise<[number, Delivery]> => {
        const channel = channels.get(id)!
        if (isQuiet(channel, now)) return [id, { state: 'held' }]
        try {
          await send(channel, notice, mailer, env.EMAIL_FROM || undefined, env.DB)
          return [id, { state: 'sent' }]
        } catch (error) {
          return [id, await failed(env.DB, channel, notice, error, now)]
        }
      }),
    )
    // One row for Notifications' list, then the held sends, each pointing at it to say how it went later
    const sent = await env.DB.prepare(
      'INSERT INTO sent_notifications (at, payload, deliveries) VALUES (?, ?, ?) RETURNING id',
    )
      .bind(now, JSON.stringify(live[0][1]), JSON.stringify(Object.fromEntries(deliveries)))
      .first<{ id: number }>()
    const held = live.filter((_, i) => deliveries[i][1].state === 'held')
    for (const [id, notice] of held)
      await env.DB.prepare('INSERT INTO held_notifications (channel_id, payload, at, sent_id) VALUES (?, ?, ?, ?)')
        .bind(id, JSON.stringify(notice), now, sent?.id ?? null)
        .run()
  }
}

/** A held send's outcome, on every sent notification it came from */
const settle = (db: D1Database, channelId: number, sentIds: number[], delivery: Delivery) =>
  sentIds.length
    ? db
        .prepare(
          `UPDATE sent_notifications SET deliveries = json_set(deliveries, '$."' || ? || '"', json(?))
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .bind(String(channelId), JSON.stringify(delivery), JSON.stringify(sentIds))
        .run()
    : undefined

// Held notices that matter most, sent over a newer one: an outage still going on mustn't hide behind a new issue
const URGENT = ['monitor_down', 'metric_critical']

/** After quiet hours: what each channel held, sent as one notice (an outage or a critical alert first, else the newest,
 * saying how many came with it). The rows are taken before sending, so two cron runs at once can't both send them */
export async function flushHeld(env: NotifyEnv, now = Date.now()): Promise<void> {
  const held = (
    await env.DB.prepare('SELECT * FROM held_notifications ORDER BY at').all<{
      id: number
      channel_id: number
      payload: string
      sent_id: number | null
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
    const taken = (
      await env.DB.prepare('DELETE FROM held_notifications WHERE id IN (SELECT value FROM json_each(?)) RETURNING id')
        .bind(JSON.stringify(rows.map((r) => r.id)))
        .all<{ id: number }>()
    ).results
    if (!channel || !taken.length) continue
    const mine = new Set(taken.map((t) => t.id))
    const notices = rows.filter((r) => mine.has(r.id)).map((r) => JSON.parse(r.payload) as Notice)
    const first = notices.findLast((n) => URGENT.includes(n.kind)) ?? notices.at(-1)!
    const notice = notices.length > 1 ? { ...first, heldMore: notices.length - 1 } : first
    let delivery: Delivery = { state: 'sent' }
    try {
      await send(channel, notice, mailer, env.EMAIL_FROM || undefined, env.DB)
    } catch (error) {
      delivery = await failed(env.DB, channel, notice, error, now)
    }
    const sentIds = rows.flatMap((r) => (mine.has(r.id) && r.sent_id !== null ? [r.sent_id] : []))
    await settle(env.DB, id, sentIds, delivery)
  }
}
