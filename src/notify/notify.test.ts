import { describe, expect, it } from 'vitest'
import { isQuiet, telegramError, telegramRequest, telegramToken, webhookBody } from './channels'
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
      text: expect.stringContaining('@everyone <b> & co'),
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: expect.stringMatching(/^\*@everyone &lt;b&gt; &amp; co\*\n/) },
        },
        { type: 'actions', elements: [{ type: 'button', url: n.url }] },
      ],
    })
    expect(webhookBody('discord', n)).toEqual({
      embeds: [{ title: '@everyone <b> & co', url: n.url, description: expect.any(String), color: 0xdc2626 }],
      allowed_mentions: { parse: [] },
    })
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
