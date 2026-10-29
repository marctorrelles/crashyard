import { describe, expect, it, vi } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { isQuiet, telegramError, telegramRequest, telegramToken, webhookBody } from './channels'
import { dispatch, flushHeld } from './dispatch'

// dispatch reaches email.ts, which imports the Workers runtime's email module: not in Node, and not sent here
vi.mock('cloudflare:email', () => ({ EmailMessage: class {} }))
import { crossed, type Notice, noticeLine, type Route, routeTakes, thresholdFor } from './notice'

const notice = (over: Partial<Notice> = {}): Notice => ({
  kind: 'new',
  project: { id: 1, slug: 'pocketband', name: 'pocketband' },
  issue: { id: 7, title: 'EXC_BAD_ACCESS: doCrash', culprit: 'doCrash', level: 'fatal', count: 1 },
  event: { release: '1.0 (10)', environment: 'production', level: 'fatal', device: 'iPad13,1' },
  url: 'https://crashyard.example.com/issues/7',
  ...over,
})
const route = (over: Partial<Route> = {}): Route => ({
  id: 1,
  project_id: null,
  kinds: '["new","threshold","regression"]',
  levels: null,
  environments: '["production"]',
  thresholds: '[10,100,1000]',
  channel_ids: '[1]',
  ...over,
})

describe('routes', () => {
  it('take the kinds, projects, levels and environments they name', () => {
    expect(routeTakes(route(), notice())).toBe(true)
    expect(routeTakes(route({ project_id: 2 }), notice())).toBe(false)
    expect(routeTakes(route({ kinds: '["regression"]' }), notice())).toBe(false)
    expect(routeTakes(route({ levels: '["error"]' }), notice())).toBe(false)
    expect(routeTakes(route(), notice({ event: { level: 'fatal', environment: 'development' } }))).toBe(false)
  })

  it('pass a threshold once, at the event that reaches it, each route by its own', () => {
    expect(crossed([10, 100], 9, 10)).toEqual([10])
    expect(crossed([10, 100], 10, 11)).toEqual([])
    const at = (before: number, count: number) =>
      notice({ kind: 'threshold', countBefore: before, issue: { ...notice().issue, count } })
    expect(thresholdFor(route(), at(99, 100))).toBe(100)
    expect(thresholdFor(route({ thresholds: '[50]' }), at(99, 100))).toBeUndefined()
    expect(routeTakes(route(), at(11, 12))).toBe(false)
  })

  it('take a frequency notice only for the route whose limit it reached', () => {
    const r = route({ id: 3, kinds: '["frequency"]' })
    const reached = notice({ kind: 'frequency', routeId: 3, rate: { count: 50, what: 'events', minutes: 10 } })
    expect(routeTakes(r, reached)).toBe(true)
    expect(routeTakes(r, { ...reached, routeId: 4 })).toBe(false)
    expect(noticeLine(reached)).toBe('pocketband · 1.0 (10) · iPad13,1 · 50 events in 10 minutes')
    expect(noticeLine({ ...reached, rate: { count: 10, what: 'users', minutes: 60 } })).toMatch(/10 users in an hour$/)
    expect(noticeLine({ ...reached, rate: { count: 1, what: 'events', minutes: 10 } })).toMatch(
      /· 1 event in 10 minutes$/,
    )
    expect(noticeLine({ ...reached, heldMore: 3 })).toMatch(/minutes · 3 more arrived during quiet hours$/)
  })

  it('filter issue alerts by release and tags, and not a monitor’s', () => {
    const r = route({ kinds: '["new","monitor_down"]', releases: '["2.*"]', environments: null })
    expect(routeTakes(r, notice())).toBe(false)
    expect(routeTakes(r, notice({ event: { ...notice().event, release: '2.1' } }))).toBe(true)
    expect(routeTakes(r, notice({ kind: 'monitor_down', event: { level: 'fatal' } }))).toBe(true)
  })

  it('take every metric alert kind as one, whatever the levels', () => {
    const r = route({ kinds: '["metric"]', levels: '["fatal"]' })
    for (const kind of ['metric_warning', 'metric_critical', 'metric_resolved'] as const)
      expect(routeTakes(r, notice({ kind, event: { level: 'info' } }))).toBe(true)
    expect(routeTakes(route({ project_id: 2, kinds: '["metric"]' }), notice({ kind: 'metric_critical' }))).toBe(false)
  })
})

describe('channels', () => {
  it('write through a Telegram bot: the title in bold, escaped, and a button to the issue', async () => {
    const request = telegramRequest(
      { token: '1:abc', chat: '42' },
      notice({ issue: { ...notice().issue, title: 'a < b & c' } }),
    )
    expect(request.url).toBe('https://api.telegram.org/bot1:abc/sendMessage')
    expect(await request.json()).toMatchObject({
      chat_id: '42',
      text: '<b>a &lt; b &amp; c</b>\npocketband · 1.0 (10) · iPad13,1 · New issue',
      parse_mode: 'HTML',
      disable_notification: false,
      reply_markup: { inline_keyboard: [[{ text: 'Open in crashyard', url: notice().url }]] },
    })
    const weekly = telegramRequest(
      { token: 't', chat: '1', server: 'http://localhost:8081/' },
      notice({ kind: 'weekly' }),
    )
    expect(weekly.url).toBe('http://localhost:8081/bott/sendMessage')
    expect(((await weekly.json()) as { disable_notification: boolean }).disable_notification).toBe(true)
  })

  it('find a bot token in what’s pasted, and say what Telegram’s refusals mean', () => {
    const token = '8123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
    expect(telegramToken(` Use this token to access the HTTP API:\n${token}\nKeep your token secure`)).toBe(token)
    expect(telegramToken('@my_crashyard_bot')).toBeNull()
    expect(telegramError(404)).toMatch(/no bot with that token/)
    expect(telegramError(400, 'Bad Request: chat not found')).toMatch(/write to the bot first/)
    expect(telegramError(500, 'oops')).toBe('Telegram answered 500: oops')
  })

  it('speak Slack’s blocks and Discord’s embeds, escaped, mentioning no one', () => {
    const n = notice({ issue: { ...notice().issue, title: '@everyone <b> & co' } })
    expect(webhookBody('slack', n)).toMatchObject({
      text: expect.stringContaining('@everyone &lt;b&gt; &amp; co'),
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: expect.stringMatching(/^\*@everyone &lt;b&gt; &amp; co\*\n/) },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', url: n.url },
            { type: 'button', text: { text: 'Resolve' }, url: `${n.url}?do=resolve` },
            { type: 'button', text: { text: 'Ignore' }, url: `${n.url}?do=ignore` },
            { type: 'button', text: { text: 'Assign to me' }, url: `${n.url}?do=assign` },
          ],
        },
      ],
    })
    expect(webhookBody('discord', n)).toEqual({
      embeds: [{ title: '@everyone <b> & co', url: n.url, description: expect.any(String), color: 0xdc2626 }],
      allowed_mentions: { parse: [] },
    })
  })

  it('offer an issue’s actions: Telegram’s act in the chat once its webhook is set, the rest link to the page', async () => {
    const keyboard = async (config: { secret?: string; owner?: string }, n = notice()) =>
      (
        (await telegramRequest({ token: '1:abc', chat: '42', ...config }, n).json()) as {
          reply_markup: { inline_keyboard: { text: string; callback_data?: string }[][] }
        }
      ).reply_markup.inline_keyboard
    expect(await keyboard({ secret: 's', owner: 'me@example.com' })).toEqual([
      [
        { text: 'Resolve', callback_data: 'r:7' },
        { text: 'Ignore', callback_data: 'i:7' },
        { text: 'Assign to me', callback_data: 'a:7' },
      ],
      [{ text: 'Open in crashyard', url: notice().url }],
    ])
    // No owner, no Assign to me; no webhook or no issue, only Open
    expect((await keyboard({ secret: 's' }))[0].map((b) => b.text)).toEqual(['Resolve', 'Ignore'])
    expect(await keyboard({})).toHaveLength(1)
    expect(await keyboard({ secret: 's' }, notice({ kind: 'monitor_down' }))).toHaveLength(1)

    const discord = webhookBody('discord', notice()) as { embeds: { description: string }[] }
    expect(discord.embeds[0].description).toContain(`[Resolve](${notice().url}?do=resolve) · [Ignore](`)
    expect(webhookBody('json', notice())).toMatchObject({
      actions: { resolve: `${notice().url}?do=resolve`, assign: `${notice().url}?do=assign` },
    })
    expect(webhookBody('json', notice({ kind: 'weekly' }))).not.toHaveProperty('actions.resolve')
  })

  it('keep quiet hours, across midnight too', () => {
    const at = (h: number) => Date.UTC(2026, 0, 1, h)
    expect(isQuiet({ quiet_from: 22 * 60, quiet_to: 7 * 60 }, at(23))).toBe(true)
    expect(isQuiet({ quiet_from: 22 * 60, quiet_to: 7 * 60 }, at(3))).toBe(true)
    expect(isQuiet({ quiet_from: 22 * 60, quiet_to: 7 * 60 }, at(12))).toBe(false)
    expect(isQuiet({ quiet_from: null, quiet_to: null }, at(3))).toBe(false)
  })

  it('keep quiet hours in their own time zone, across daylight saving', () => {
    const night = { quiet_from: 22 * 60, quiet_to: 7 * 60, quiet_zone: 'Europe/Madrid' }
    // 21:30 UTC is 22:30 in Madrid in winter, 23:30 in summer: quiet both times
    expect(isQuiet(night, Date.UTC(2026, 0, 15, 21, 30))).toBe(true)
    expect(isQuiet(night, Date.UTC(2026, 6, 15, 21, 30))).toBe(true)
    // 05:30 UTC is 06:30 in winter, still quiet, and 07:30 in summer, not
    expect(isQuiet(night, Date.UTC(2026, 0, 15, 5, 30))).toBe(true)
    expect(isQuiet(night, Date.UTC(2026, 6, 15, 5, 30))).toBe(false)
  })
})

describe('held notifications', () => {
  it('send an outage held over a newer notice, once, however many runs flush at once', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO channels (id, kind, name, config, created_at)
      VALUES (1, 'webhook', 'Hook', '{"url":"https://hook.example","format":"json"}', 0)`)
    const held = (n: Notice, at: number) =>
      db.sqlite
        .prepare('INSERT INTO held_notifications (channel_id, payload, at) VALUES (1, ?, ?)')
        .run(JSON.stringify(n), at)
    db.sqlite.exec(
      `INSERT INTO sent_notifications (id, at, payload, deliveries) VALUES (5, 2, '{}', '{"1":{"state":"held"}}')`,
    )
    held(notice({ kind: 'monitor_down', issue: { ...notice().issue, title: 'API' } }), 1)
    held(notice(), 2)
    db.sqlite.exec('UPDATE held_notifications SET sent_id = 5 WHERE at = 2')
    const sent: { kind: string; issue: { title: string } }[] = []
    vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return new Response('{}')
    })
    try {
      await Promise.all([flushHeld({ DB: db }), flushHeld({ DB: db })])
    } finally {
      vi.unstubAllGlobals()
    }
    expect(sent.map((s) => [s.kind, s.issue.title])).toEqual([['monitor_down', 'API']])
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM held_notifications').get()).toEqual({ n: 0 })
    expect(db.sqlite.prepare('SELECT deliveries FROM sent_notifications').get()).toEqual({
      deliveries: '{"1":{"state":"sent"}}',
    })
  })
})

describe('sent notifications', () => {
  it('keep one row a notice, with what each channel did: sent, refused or held', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`INSERT INTO channels (id, kind, name, config, created_at, quiet_from, quiet_to) VALUES
      (1, 'webhook', 'Up', '{"url":"https://up.example","format":"json"}', 0, NULL, NULL),
      (2, 'webhook', 'Down', '{"url":"https://down.example","format":"json"}', 0, NULL, NULL),
      (3, 'webhook', 'Asleep', '{"url":"https://up.example","format":"json"}', 0, 0, 1439)`)
    db.sqlite.exec(`INSERT INTO routes (project_id, kinds, thresholds, channel_ids, created_at)
      VALUES (NULL, '["new"]', '[]', '[1,2,3,9]', 0)`)
    vi.stubGlobal('fetch', async (url: string) => new Response('no', { status: url.includes('down') ? 500 : 200 }))
    try {
      await dispatch({ DB: db }, [notice()], 1000)
    } finally {
      vi.unstubAllGlobals()
    }
    const rows = db.sqlite.prepare('SELECT * FROM sent_notifications').all() as { id: number; deliveries: string }[]
    expect(rows).toHaveLength(1)
    const deliveries = JSON.parse(rows[0].deliveries)
    expect(Object.keys(deliveries)).toEqual(['1', '2', '3'])
    expect(deliveries[1]).toEqual({ state: 'sent' })
    expect(deliveries[2].state).toBe('failed')
    expect(deliveries[2].error).toMatch(/500/)
    expect(deliveries[3]).toEqual({ state: 'held' })
    expect(db.sqlite.prepare('SELECT channel_id, sent_id FROM held_notifications').all()).toEqual([
      { channel_id: 3, sent_id: rows[0].id },
    ])
  })
})
