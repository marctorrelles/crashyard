import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { getMonitor } from '../data/monitors'
import { setPaused } from '../data/monitors'
import { afterResult, atPath, check, MAX_CRON_MONITORS, recordCheckIn, runMonitors } from './monitors'

const m = (over: Partial<Parameters<typeof afterResult>[0]> = {}) => ({
  status: 'ok' as const,
  failures: 0,
  successes: 3,
  failure_threshold: 2,
  recovery_threshold: 1,
  ...over,
})

describe('monitors', () => {
  it('open an incident at the failure threshold, and close it at the recovery threshold', () => {
    expect(afterResult(m(), false)).toMatchObject({ status: 'ok', failures: 1, change: undefined })
    expect(afterResult(m({ failures: 1 }), false)).toMatchObject({ status: 'failing', failures: 2, change: 'down' })
    expect(afterResult(m({ status: 'failing', failures: 5 }), false)).toMatchObject({
      status: 'failing',
      change: undefined,
    })
    expect(afterResult(m({ status: 'failing', failures: 5, recovery_threshold: 2, successes: 0 }), true)).toMatchObject(
      { status: 'failing', successes: 1 },
    )
    expect(afterResult(m({ status: 'failing', successes: 1, recovery_threshold: 2 }), true)).toMatchObject({
      status: 'ok',
      change: 'up',
    })
    expect(afterResult(m({ status: 'pending', successes: 0 }), true)).toMatchObject({ status: 'ok', change: undefined })
  })

  it('check a URL: its status, what the page says, and how long it takes', async () => {
    const answer = (status: number, body = 'all good') =>
      (async () => new Response(body, { status })) as unknown as typeof fetch
    expect(await check({ url: 'https://x', intervalMinutes: 1 }, answer(200))).toMatchObject({ ok: true, status: 200 })
    expect(await check({ url: 'https://x', intervalMinutes: 1 }, answer(503))).toMatchObject({
      ok: false,
      error: 'returned HTTP 503',
    })
    expect(await check({ url: 'https://x', intervalMinutes: 1, expectedStatus: 401 }, answer(401))).toMatchObject({
      ok: true,
    })
    expect(await check({ url: 'https://x', intervalMinutes: 1, mustContain: 'catalog' }, answer(200))).toMatchObject({
      ok: false,
      error: 'the response didn’t contain “catalog”',
    })
    const never = ((_: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))),
      )) as unknown as typeof fetch
    expect(await check({ url: 'https://x', intervalMinutes: 1, timeoutMs: 20 }, never)).toMatchObject({
      ok: false,
      error: 'timed out',
    })
  })
})

describe('uptime requests', () => {
  it('sends the method, headers and body, with a sentry-trace header', async () => {
    let seen: Request | undefined
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init)
      return new Response('{}')
    }) as unknown as typeof fetch
    await check(
      {
        url: 'https://x/ping',
        method: 'POST',
        headers: [['Authorization', 'Bearer t']],
        body: '{"ping":true}',
        intervalMinutes: 1,
      },
      fetcher,
    )
    expect(seen?.method).toBe('POST')
    expect(seen?.headers.get('authorization')).toBe('Bearer t')
    expect(await seen?.text()).toBe('{"ping":true}')
    expect(seen?.headers.get('sentry-trace')).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}-0$/)
    // A GET sends no body, whatever's stored
    await check({ url: 'https://x', method: 'GET', body: 'x', intervalMinutes: 1 }, fetcher)
    expect(seen?.body).toBeNull()
  })

  it('passes and fails assertions: a status in a list, a header containing a value, a JSON path', async () => {
    const answer = (status: number, body: string, headers: Record<string, string> = {}) =>
      (async () => new Response(body, { status, headers })) as unknown as typeof fetch
    const json = answer(201, '{"status":"ok","checks":[{"db":true}]}', { 'content-type': 'application/json' })
    const base = { url: 'https://x', intervalMinutes: 1 }
    const passes = await check(
      {
        ...base,
        assertions: [
          { kind: 'status', in: [200, 201] },
          { kind: 'header', name: 'content-type', contains: 'json' },
          { kind: 'json', path: '$.status', equals: 'ok' },
          { kind: 'json', path: '$.checks[0].db', equals: 'true' },
        ],
      },
      json,
    )
    expect(passes).toMatchObject({ ok: true, status: 201 })
    expect(await check({ ...base, assertions: [{ kind: 'status', in: [200] }] }, json)).toMatchObject({
      ok: false,
      error: 'returned HTTP 201, not 200',
    })
    // A status assertion takes the place of "any 2xx"
    expect(await check({ ...base, assertions: [{ kind: 'status', in: [503] }] }, answer(503, ''))).toMatchObject({
      ok: true,
    })
    expect(
      await check({ ...base, assertions: [{ kind: 'header', name: 'x-version', contains: '2' }] }, json),
    ).toMatchObject({ ok: false, error: 'the x-version header didn’t contain “2”' })
    expect(
      await check({ ...base, assertions: [{ kind: 'json', path: '$.status', equals: 'down' }] }, json),
    ).toMatchObject({ ok: false, error: '$.status was “ok”, not “down”' })
    expect(
      await check({ ...base, assertions: [{ kind: 'json', path: '$.missing', equals: 'x' }] }, answer(200, 'not json')),
    ).toMatchObject({ ok: false, error: 'the response had nothing at $.missing' })
    expect(atPath({ a: [{ b: 1 }] }, 'a[0].b')).toBe(1)
  })
})

describe('cron monitors', () => {
  const NOW = Date.UTC(2026, 9, 26, 12)
  const config = { schedule: { type: 'crontab', value: '0 * * * *' } }
  const seeded = () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
    return db
  }

  it('keeps a status per environment from its check-ins', async () => {
    const db = seeded()
    const env = { DB: db }
    await recordCheckIn(
      env,
      1,
      { monitor_slug: 'job', status: 'ok', environment: 'production', monitor_config: config },
      NOW,
    )
    await recordCheckIn(env, 1, { monitor_slug: 'job', status: 'error', environment: 'staging' }, NOW + 1)
    await recordCheckIn(env, 1, { monitor_slug: 'job', status: 'in_progress', environment: 'canary' }, NOW + 2)
    const id = (db.sqlite.prepare('SELECT id FROM monitors').get() as { id: number }).id
    const page = (await getMonitor(db, id, NOW + 3))!
    expect(page.environments).toEqual([
      { environment: 'canary', status: 'in_progress', last_check_in: NOW + 2 },
      { environment: 'production', status: 'ok', last_check_in: NOW },
      { environment: 'staging', status: 'failing', last_check_in: NOW + 1 },
    ])
    // Two runs finished, one ok: half over each period
    expect(page.uptime).toEqual({ day: 0.5, week: 0.5, month: 0.5 })
  })

  it('writes the same check-in on a retry of one without an id', async () => {
    const db = seeded()
    const env = { DB: db }
    const count = () => db.sqlite.prepare('SELECT COUNT(*) AS n FROM check_ins').get()
    await recordCheckIn(
      env,
      1,
      { monitor_slug: 'job', status: 'in_progress', monitor_config: config },
      NOW,
      'a'.repeat(32),
    )
    // An ok without an id finishes the run in progress; its retry, with the same time, finds that run again
    for (let i = 0; i < 2; i++)
      await recordCheckIn(env, 1, { monitor_slug: 'job', status: 'ok' }, NOW + 1000, 'b'.repeat(32))
    expect(count()).toEqual({ n: 1 })
    expect(db.sqlite.prepare('SELECT id, status FROM check_ins').get()).toEqual({ id: 'a'.repeat(32), status: 'ok' })
    // With no run in progress it's a check-in of its own, written once
    for (let i = 0; i < 2; i++)
      await recordCheckIn(env, 1, { monitor_slug: 'job', status: 'error' }, NOW + 2000, 'c'.repeat(32))
    expect(count()).toEqual({ n: 2 })
  })

  it('never touches an uptime check with the same slug, nor another monitor’s run', async () => {
    const db = seeded()
    const env = { DB: db }
    const uptime = JSON.stringify({ url: 'https://example.com', intervalMinutes: 1 })
    db.sqlite.exec(`INSERT INTO monitors (id, project_id, slug, name, kind, config, status, created_at)
      VALUES (7, 1, 'api', 'API', 'uptime', '${uptime}', 'ok', 0)`)
    const down = await recordCheckIn(env, 1, { monitor_slug: 'api', status: 'error', monitor_config: config }, NOW)
    expect(down).toBeUndefined()
    expect(db.sqlite.prepare('SELECT kind, config, status FROM monitors WHERE id = 7').get()).toEqual({
      kind: 'uptime',
      config: uptime,
      status: 'ok',
    })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM incidents').get()).toEqual({ n: 0 })
    // A known check-in id sent for another monitor leaves the first one's run as it was
    const id = 'd'.repeat(32)
    await recordCheckIn(env, 1, { monitor_slug: 'one', check_in_id: id, status: 'ok', monitor_config: config }, NOW)
    await recordCheckIn(env, 1, { monitor_slug: 'two', check_in_id: id, status: 'error', monitor_config: config }, NOW)
    expect(db.sqlite.prepare('SELECT status FROM check_ins WHERE id = ?').get(id)).toEqual({ status: 'ok' })
  })

  it('runs uptime checks five at a time, and leaves what the deadline doesn’t reach for the next minute', async () => {
    const db = seeded()
    const env = { DB: db }
    const uptime = JSON.stringify({ url: 'https://example.com', intervalMinutes: 1 })
    for (let id = 1; id <= 8; id++)
      db.sqlite.exec(`INSERT INTO monitors (id, project_id, slug, name, kind, config, status, next_due, created_at)
        VALUES (${id}, 1, 'u${id}', 'U', 'uptime', '${uptime}', 'ok', 0, 0)`)
    let open = 0
    let most = 0
    const fetcher = (async () => {
      most = Math.max(most, ++open)
      await new Promise((r) => setTimeout(r, 5))
      open--
      return new Response('ok')
    }) as unknown as typeof fetch
    await runMonitors(env, NOW, fetcher, Date.now() - 1)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM uptime_results').get()).toEqual({ n: 0 })
    await runMonitors(env, NOW, fetcher)
    expect(most).toBe(5)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM uptime_results').get()).toEqual({ n: 8 })
  })

  it('stays paused when paused during its check, and pausing ends its incident', async () => {
    const db = seeded()
    const env = { DB: db }
    const uptime = JSON.stringify({ url: 'https://example.com', intervalMinutes: 1 })
    db.sqlite
      .exec(`INSERT INTO monitors (id, project_id, slug, name, kind, config, status, failure_threshold, next_due, created_at)
      VALUES (1, 1, 'u', 'U', 'uptime', '${uptime}', 'ok', 1, 0, 0)`)
    const pausing = (async () => {
      await setPaused(db, 1, true, NOW)
      return new Response('', { status: 500 })
    }) as unknown as typeof fetch
    expect(await runMonitors(env, NOW, pausing)).toEqual([])
    expect(db.sqlite.prepare('SELECT status FROM monitors').get()).toEqual({ status: 'paused' })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM incidents').get()).toEqual({ n: 0 })
    // Failing, then paused and resumed: the incident it had is over
    await setPaused(db, 1, false, NOW)
    await runMonitors(env, NOW, (async () => new Response('', { status: 500 })) as unknown as typeof fetch)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM incidents WHERE closed_at IS NULL').get()).toEqual({ n: 1 })
    await setPaused(db, 1, true, NOW + 1)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM incidents WHERE closed_at IS NULL').get()).toEqual({ n: 0 })
  })

  it('makes at most MAX_CRON_MONITORS monitors from a project’s check-ins', async () => {
    const db = seeded()
    const env = { DB: db }
    for (let i = 0; i < MAX_CRON_MONITORS + 5; i++)
      await recordCheckIn(env, 1, { monitor_slug: `job-${i}`, status: 'ok', monitor_config: config }, NOW)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM monitors').get()).toEqual({ n: MAX_CRON_MONITORS })
  })

  it('mutes a monitor failing for 14 days, with no alert until it recovers', async () => {
    const db = seeded()
    const env = { DB: db }
    await recordCheckIn(env, 1, { monitor_slug: 'job', status: 'error', monitor_config: config }, NOW)
    expect(db.sqlite.prepare('SELECT status FROM monitors').get()).toEqual({ status: 'failing' })
    await runMonitors(env, NOW + 13 * 864e5, (async () => new Response()) as unknown as typeof fetch)
    expect(db.sqlite.prepare('SELECT muted_at FROM monitors').get()).toEqual({ muted_at: null })
    const later = NOW + 14 * 864e5 + 1
    await runMonitors(env, later)
    expect(db.sqlite.prepare('SELECT muted_at FROM monitors').get()).toEqual({ muted_at: later })
    // Recovering unmutes it and still says so
    const up = await recordCheckIn(env, 1, { monitor_slug: 'job', status: 'ok' }, later + 1)
    expect(up?.kind).toBe('monitor_up')
    expect(db.sqlite.prepare('SELECT muted_at FROM monitors').get()).toEqual({ muted_at: null })
  })

  it('lists errors that name the monitor, or share a check-in’s trace', async () => {
    const db = seeded()
    const trace = 'ab'.repeat(16)
    await recordCheckIn(
      { DB: db },
      1,
      { monitor_slug: 'job', status: 'in_progress', monitor_config: config, contexts: { trace: { trace_id: trace } } },
      NOW,
    )
    db.sqlite.exec(`
      INSERT INTO issues (id, project_id, fingerprint, title, culprit, type, level, platform, first_seen, last_seen)
        VALUES (1, 1, 'f', 'Backup failed', '', 'error', 'error', 'node', 0, 0);
      INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data, trace_id) VALUES
        ('e1', 1, 1, 0, ${NOW + 1}, 'error', 'node', '{}', '${trace}'),
        ('e2', 1, 1, 0, ${NOW + 2}, 'error', 'node', '{}', NULL),
        ('e3', 1, 1, 0, ${NOW + 3}, 'error', 'node', '{}', 'other');
      INSERT INTO event_tags (event_id, project_id, key, value) VALUES ('e2', 1, 'monitor.slug', 'job'), ('e3', 1, 'monitor.slug', 'else');
    `)
    const id = (db.sqlite.prepare('SELECT id FROM monitors').get() as { id: number }).id
    expect((await getMonitor(db, id, NOW + 4))!.errors.map((e) => e.id)).toEqual(['e2', 'e1'])
  })
})
