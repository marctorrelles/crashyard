import { describe, expect, it } from 'vitest'
import { verifyAction, actionUrl } from './actions'
import { barkRequest, barkSettings, isQuiet, ntfyRequest, webhookBody } from './channels'
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
})

describe('channels', () => {
  it('push to ntfy with the issue as the title and its buttons as actions', () => {
    const request = ntfyRequest(
      { topic: 'secret topic' },
      notice({ actions: { resolve: 'https://r', ignore: 'https://i' } }),
    )
    expect(request.url).toBe('https://ntfy.sh/secret%20topic')
    expect(request.headers.get('title')).toBe('EXC_BAD_ACCESS: doCrash')
    expect(request.headers.get('actions')).toBe(
      'http, Resolve, https://r, method=POST, clear=true; http, Ignore, https://i, method=POST, clear=true',
    )
    expect(noticeLine(notice())).toBe('pocketband · 1.0 (10) · iPad13,1 · new')
  })

  it('push through Bark, time sensitive for a new issue, the week quietly', async () => {
    const request = barkRequest({ key: 'k3y' }, notice())
    expect(request.url).toBe('https://api.day.app/push')
    expect(await request.json()).toMatchObject({
      device_key: 'k3y',
      title: 'EXC_BAD_ACCESS: doCrash',
      body: 'pocketband · 1.0 (10) · iPad13,1 · new',
      level: 'timeSensitive',
    })
    const weekly = barkRequest({ key: 'k', server: 'https://bark.example.com/' }, notice({ kind: 'weekly' }))
    expect(weekly.url).toBe('https://bark.example.com/push')
    expect(((await weekly.json()) as { level: string }).level).toBe('passive')
  })

  it('read a Bark key, or the app’s whole URL', () => {
    expect(barkSettings(' k3y ', '')).toEqual({ server: undefined, key: 'k3y' })
    expect(barkSettings('https://api.day.app/k3y/title/body', '')).toEqual({ server: undefined, key: 'k3y' })
    expect(barkSettings('https://bark.example.com/k3y/', '')).toEqual({
      server: 'https://bark.example.com',
      key: 'k3y',
    })
  })

  it('speak Slack’s and Discord’s webhook formats', () => {
    expect(webhookBody('slack', notice())).toEqual({ text: expect.stringContaining('EXC_BAD_ACCESS') })
    expect(webhookBody('discord', notice())).toEqual({ content: expect.stringContaining('/issues/7') })
  })

  it('keep quiet hours, across midnight too', () => {
    const at = (h: number) => Date.UTC(2026, 0, 1, h)
    expect(isQuiet({ quiet_from: 22 * 60, quiet_to: 7 * 60 }, at(23))).toBe(true)
    expect(isQuiet({ quiet_from: 22 * 60, quiet_to: 7 * 60 }, at(3))).toBe(true)
    expect(isQuiet({ quiet_from: 22 * 60, quiet_to: 7 * 60 }, at(12))).toBe(false)
    expect(isQuiet({ quiet_from: null, quiet_to: null }, at(3))).toBe(false)
  })
})

describe('push buttons', () => {
  it('only work for their issue and action, and until they expire', async () => {
    const url = new URL(await actionUrl('https://c.example', 'secret', 7, 'resolve', 1000))
    const expires = Number(url.searchParams.get('expires'))
    const signature = url.searchParams.get('signature')!
    expect(await verifyAction('secret', 7, 'resolve', expires, signature, 2000)).toBe(true)
    expect(await verifyAction('secret', 8, 'resolve', expires, signature, 2000)).toBe(false)
    expect(await verifyAction('secret', 7, 'ignore', expires, signature, 2000)).toBe(false)
    expect(await verifyAction('other', 7, 'resolve', expires, signature, 2000)).toBe(false)
    expect(await verifyAction('secret', 7, 'resolve', expires, signature, expires + 1)).toBe(false)
  })
})
