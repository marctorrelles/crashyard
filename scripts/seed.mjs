// Fills the local dev database (what `pnpm dev` uses) with a month of made-up crashes (and two days of logs) from three apps, through the same
// code ingest uses, so the dashboard has something to show. Wipes local projects first. Never touches a deployment.
//   pnpm seed
import { execFileSync } from 'node:child_process'
import { createServer } from 'vite'
import { getPlatformProxy } from 'wrangler'

execFileSync('pnpm', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'], { stdio: 'ignore' })
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})
const load = (path) => vite.ssrLoadModule(path)
const { normalizeEvent } = await load('/src/ingest/event.ts')
const { fingerprintOf } = await load('/src/ingest/grouping.ts')
const { storeEvent } = await load('/src/ingest/store.ts')
const { changeIssues, addNote } = await load('/src/data/issues.ts')
const { storeLogs } = await load('/src/ingest/logs.ts')
const { storeSessions, storeTransaction } = await load('/src/performance/ingest.ts')
const proxy = await getPlatformProxy({ persist: { path: '.wrangler/state/v3' } })
const db = proxy.env.DB

const DAY = 864e5
const now = Date.now()
let seed = 7
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
const pick = (list) => list[Math.floor(random() * list.length)]
const hex = (n) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join('')

await db.prepare('DELETE FROM projects').run()
await db.prepare('DELETE FROM channels').run()
await db.prepare('DELETE FROM routes').run()
// (projects cascade to their monitors)
const project = async (slug, name, platform) =>
  db
    .prepare('INSERT INTO projects (slug, name, platform, public_key, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .bind(slug, name, platform, hex(32), now - 40 * DAY)
    .first()
const pocketband = await project('pocketband', 'pocketband', 'apple')
const notes = await project('notes-web', 'notes web', 'javascript')
const sync = await project('sync', 'sync server', 'node')

const apple = (release, device) => ({
  platform: 'cocoa',
  release,
  environment: 'production',
  contexts: {
    device: { family: device.startsWith('iPad') ? 'iPad' : 'iPhone', model: device, arch: 'arm64e' },
    os: { name: 'iOS', version: pick(['18.6', '26.0', '26.1']) },
    app: { app_name: 'pocketband', app_version: release.split(' ')[0], app_build: release.match(/\((\d+)\)/)?.[1] },
  },
  breadcrumbs: [
    { timestamp: 0, category: 'ui.lifecycle', message: 'SongView appeared' },
    { timestamp: 0, category: 'audio', message: 'engine started (48000 Hz, 256 frames)' },
    { timestamp: 0, category: 'touch', message: 'pad 3 pressed' },
  ],
})
const native = (fn, file, line, inApp = true) => ({
  function: fn,
  filename: file,
  lineno: line,
  in_app: inApp,
  package: inApp
    ? '/private/var/containers/Bundle/Application/pocketband.app/pocketband'
    : '/System/Library/Frameworks/AVFAudio.framework/AVFAudio',
})
const browser = (release) => ({
  platform: 'javascript',
  release,
  environment: 'production',
  request: { url: 'https://notes.example.com/n/42', headers: { 'User-Agent': 'Mozilla/5.0' } },
  contexts: {
    browser: { name: pick(['Chrome', 'Safari', 'Firefox']), version: pick(['141', '18.6', '143']) },
    os: { name: pick(['macOS', 'Windows', 'iOS', 'Android']) },
  },
  breadcrumbs: [
    { timestamp: 0, category: 'navigation', data: { from: '/', to: '/n/42' } },
    { timestamp: 0, category: 'fetch', data: { method: 'GET', url: '/api/notes/42', status_code: 200 } },
    { timestamp: 0, category: 'ui.click', message: 'button.toolbar-bold' },
  ],
})
const js = (fn, file, line, pre, ctx, post, inApp = true) => ({
  function: fn,
  filename: file,
  abs_path: `https://notes.example.com/assets/${file.split('/').pop()}`,
  lineno: line,
  colno: 17,
  in_app: inApp,
  pre_context: pre,
  context_line: ctx,
  post_context: post,
})

// Each issue: how to make one of its events, how many, over which days ago, and from which releases
const ISSUES = [
  {
    project: pocketband,
    n: 140,
    days: [24, 0],
    make: (release) => ({
      ...apple(release, pick(['iPad13,1', 'iPad14,3', 'iPhone15,2', 'iPhone16,1'])),
      level: 'fatal',
      exception: {
        values: [
          {
            type: 'EXC_BAD_ACCESS',
            value: 'KERN_INVALID_ADDRESS at 0x0000000000000010',
            mechanism: { type: 'mach', handled: false },
            stacktrace: {
              frames: [
                native('start', 'dyld', 0, false),
                native('AVAudioEngine.renderBlock', 'AVFAudio', 0, false),
                native('AudioEngine.render(frames:)', 'AudioEngine.swift', 212),
                native('Mixer.mix(into:count:)', 'Mixer.swift', 88),
                native('Voice.next()', 'Voice.swift', 41),
              ],
            },
          },
        ],
      },
    }),
    releases: ['1.0 (9)', '1.0 (10)'],
  },
  {
    project: pocketband,
    n: 31,
    days: [26, 9],
    make: (release) => ({
      ...apple(release, pick(['iPad13,1', 'iPhone15,2'])),
      level: 'error',
      exception: {
        values: [
          {
            type: 'NSRangeException',
            value: '*** -[__NSArrayM objectAtIndex:]: index 5 beyond bounds [0 .. 4]',
            mechanism: { type: 'nsexception', handled: false },
            stacktrace: {
              frames: [
                native('SongStore.load(_:)', 'SongStore.swift', 133),
                native('Song.pattern(at:)', 'Song.swift', 57),
              ],
            },
          },
        ],
      },
    }),
    releases: ['1.0 (9)'],
  },
  {
    project: pocketband,
    n: 55,
    days: [20, 0],
    resolveAfter: { release: '1.0 (9)' },
    make: (release) => ({
      ...apple(release, pick(['iPad13,1', 'iPhone16,1'])),
      level: 'error',
      exception: {
        values: [
          {
            type: 'Pocketband.SyncError',
            value: 'timeout(after: 12.0)',
            mechanism: { type: 'generic', handled: true },
            stacktrace: {
              frames: [
                native('SyncClient.push(_:)', 'SyncClient.swift', 76),
                native('URLSession.data(for:)', 'Foundation', 0, false),
              ],
            },
          },
        ],
      },
    }),
    releases: ['1.0 (9)', '1.0 (10)'],
  },
  {
    project: pocketband,
    n: 9,
    days: [12, 1],
    make: (release) => ({
      ...apple(release, 'iPhone15,2'),
      level: 'warning',
      message: { formatted: 'Song export took 14s' },
    }),
    releases: ['1.0 (10)'],
  },
  {
    project: pocketband,
    n: 1,
    days: [0.2, 0.2],
    make: (release) => ({
      ...apple(release, 'iPad14,3'),
      level: 'fatal',
      tags: { distribution: 'app_review' },
      exception: {
        values: [
          {
            type: 'SIGABRT',
            value: 'Fatal error: Unexpectedly found nil while unwrapping an Optional value',
            mechanism: { type: 'signal', handled: false },
            stacktrace: {
              frames: [
                native('PocketbandApp.init()', 'PocketbandApp.swift', 18),
                native('CrashReports.start()', 'CrashReports.swift', 22),
              ],
            },
          },
        ],
      },
    }),
    releases: ['1.0 (10)'],
  },
  {
    project: notes,
    n: 320,
    days: [29, 0],
    make: (release) => ({
      ...browser(release),
      level: 'error',
      user: { id: `u${Math.floor(random() * 90)}` },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'blocks')",
            mechanism: { type: 'onerror', handled: false },
            stacktrace: {
              frames: [
                js(
                  'renderRoot',
                  'node_modules/react-dom/cjs/react-dom.production.js',
                  9012,
                  [],
                  'return renderRoot(root, lanes);',
                  [],
                  false,
                ),
                js(
                  'NoteView',
                  'src/notes/note-view.tsx',
                  48,
                  ['export function NoteView({ note }: Props) {', '  const doc = useDocument(note.id)'],
                  '  const first = doc.content.blocks[0]',
                  ['  if (!first) return <Empty />', '  return <Blocks blocks={doc.content.blocks} />'],
                ),
                js(
                  'useDocument',
                  'src/notes/use-document.ts',
                  21,
                  ['  const cached = cache.get(id)'],
                  '  return cached ?? load(id)',
                  ['}'],
                ),
              ],
            },
          },
        ],
      },
    }),
    releases: ['web@2026.10.12', 'web@2026.10.20'],
  },
  {
    project: notes,
    n: 40,
    days: [18, 2],
    ignore: true,
    make: (release) => ({
      ...browser(release),
      level: 'error',
      exception: {
        values: [
          {
            type: 'ChunkLoadError',
            value: 'Loading chunk 4521 failed.',
            stacktrace: { frames: [js('requireEnsure', 'assets/index.js', 1, [], '', [], false)] },
          },
        ],
      },
    }),
    releases: ['web@2026.10.12'],
  },
  {
    project: sync,
    n: 6,
    days: [0.6, 0],
    make: () => ({
      platform: 'node',
      release: 'sync@3f9c2e1',
      environment: 'production',
      level: 'error',
      contexts: { runtime: { name: 'workerd' } },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'D1_ERROR: database is locked: SQLITE_BUSY',
            stacktrace: {
              frames: [
                {
                  function: 'handleCatalog',
                  filename: 'src/index.ts',
                  lineno: 140,
                  in_app: true,
                  context_line: "    const rows = await env.DB.prepare('SELECT * FROM songs').all()",
                },
              ],
            },
          },
        ],
      },
    }),
    releases: ['sync@3f9c2e1'],
  },
]

// One trace per app session: ten minutes
const traceOf = (at) => (Math.floor(at / 6e5) * 2654435761).toString(16).padStart(32, '0').slice(-32)

// Every event, oldest first, so first and last seen, releases and regressions come out as they would have
const events = ISSUES.flatMap((issue, i) =>
  Array.from({ length: issue.n }, (_, k) => {
    const [from, to] = issue.days
    // More recent days get more events
    const ago = to + (from - to) * random() ** 1.6
    const at = Math.round(now - ago * DAY)
    // Later releases for later events
    const share = 1 - ago / Math.max(from, 0.01)
    const release = issue.releases[Math.min(issue.releases.length - 1, Math.floor(share * issue.releases.length))]
    return { i, k, at, release }
  }),
).sort((a, b) => a.at - b.at)

const issueOf = new Map()
for (const e of events) {
  const issue = ISSUES[e.i]
  const raw = issue.make(e.release)
  raw.event_id = hex(32)
  raw.timestamp = e.at / 1000
  // The last day's events carry a trace, which the logs below share
  if (now - e.at < DAY) raw.contexts = { ...raw.contexts, trace: { trace_id: traceOf(e.at), span_id: hex(16) } }
  raw.breadcrumbs = raw.breadcrumbs?.map((b, n) => ({ ...b, timestamp: e.at / 1000 - (3 - n) * 2.5 }))
  const event = await normalizeEvent(raw, e.at, raw.event_id)
  const stored = await storeEvent(db, issue.project, event, await fingerprintOf(event))
  if (!stored) continue
  issueOf.set(e.i, stored.issue.id)
  // Resolved against the old release just before the first event of the next one
  if (issue.resolveAfter && e.release === issue.resolveAfter.release && !issue.resolved) {
    const next = events.find((x) => x.i === e.i && x.release !== e.release)
    if (next && events.filter((x) => x.i === e.i && x.release === e.release).at(-1) === e) {
      await changeIssues(db, [stored.issue.id], { action: 'resolve', inRelease: true }, 'dev@localhost', e.at + 60_000)
      issue.resolved = true
    }
  }
}
for (const [i, id] of issueOf)
  if (ISSUES[i].ignore) await changeIssues(db, [id], { action: 'ignore' }, 'dev@localhost', now - 2 * DAY)
await addNote(
  db,
  issueOf.get(0),
  'Happens when a voice is freed mid-render. Fix: keep voices alive until the next render cycle.',
  'dev@localhost',
  now - 3 * DAY,
)

// Two days of logs: what each app says while it runs
const LOGS = [
  [
    pocketband,
    'info',
    'song opened',
    () => ({ song: Math.floor(random() * 60), mode: pick(['edit', 'live']) }),
    '1.0 (10)',
  ],
  [
    pocketband,
    'info',
    'pattern saved',
    () => ({ song: Math.floor(random() * 60), steps: pick([16, 32, 64]) }),
    '1.0 (10)',
  ],
  [pocketband, 'debug', 'audio buffer resized', () => ({ frames: pick([128, 256, 512]) }), '1.0 (10)'],
  [
    pocketband,
    'warn',
    'sync retry',
    () => ({ attempt: pick([1, 2, 3]), status: pick([502, 503, 'timeout']) }),
    '1.0 (10)',
  ],
  [pocketband, 'error', 'export failed', () => ({ format: pick(['wav', 'm4a']), reason: 'disk full' }), '1.0 (10)'],
  [
    notes,
    'info',
    'note rendered',
    () => ({ blocks: Math.floor(random() * 200), ms: Math.floor(random() * 80) }),
    'web@2026.10.20',
  ],
  [notes, 'warn', 'slow render', () => ({ ms: 300 + Math.floor(random() * 900) }), 'web@2026.10.20'],
  [
    sync,
    'info',
    'catalog served',
    () => ({ songs: Math.floor(random() * 4000), ms: Math.floor(random() * 40) }),
    'sync@3f9c2e1',
  ],
]
const logs = Array.from({ length: 450 }, () => {
  const [p, level, body, attrs, release] = LOGS[Math.floor(random() ** 1.4 * LOGS.length)]
  const at = Math.round(now - random() ** 1.8 * 2 * DAY)
  return {
    p,
    log: { timestamp: at, level, body, attributes: attrs(), release, environment: 'production', traceId: traceOf(at) },
  }
}).sort((a, b) => a.log.timestamp - b.log.timestamp)
for (const { p, log } of logs)
  await storeLogs(db, p.id, [log], log.timestamp, new Date(log.timestamp).toISOString().slice(0, 10))

// Monitors: the sync server's uptime (one bad stretch), the web app's, and a nightly job that missed last night
const MIN = 60_000
const monitor = async (p, slug, name, kind, config, threshold, status) =>
  (
    await db
      .prepare(
        `INSERT INTO monitors (project_id, slug, name, kind, config, failure_threshold, status, next_due, last_seen, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(p.id, slug, name, kind, JSON.stringify(config), threshold, status, now + 5 * MIN, now - MIN, now - 30 * DAY)
      .first()
  ).id
const api = await monitor(
  sync,
  'catalog',
  'Sync server /catalog',
  'uptime',
  { url: 'https://api.pocketband.example/catalog', intervalMinutes: 5, mustContain: 'songs' },
  2,
  'ok',
)
const web = await monitor(
  notes,
  'web',
  'Notes web app',
  'uptime',
  { url: 'https://notes.example.com/', intervalMinutes: 5 },
  2,
  'ok',
)
for (let i = 40; i >= 1; i--) {
  const at = now - i * 5 * MIN
  const bad = i >= 18 && i <= 20
  await db
    .prepare('INSERT INTO uptime_results (monitor_id, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      api,
      at,
      bad ? 0 : 1,
      bad ? 502 : 200,
      bad ? 120 : 60 + Math.floor(random() * 90),
      bad ? 'answered 502' : null,
    )
    .run()
  await db
    .prepare('INSERT INTO uptime_results (monitor_id, at, ok, status, ms, error) VALUES (?, ?, 1, 200, ?, NULL)')
    .bind(web, at, 180 + Math.floor(random() * 220))
    .run()
}
await db
  .prepare("INSERT INTO incidents (monitor_id, opened_at, closed_at, reason) VALUES (?, ?, ?, 'answered 502')")
  .bind(api, now - 95 * MIN, now - 85 * MIN)
  .run()
const nightly = await monitor(
  pocketband,
  'nightly-export',
  'Nightly song export',
  'cron',
  { schedule: { type: 'crontab', value: '0 3 * * *' }, timezone: 'Europe/Madrid', checkinMargin: 10, maxRuntime: 30 },
  1,
  'failing',
)
for (let d = 12; d >= 1; d--) {
  const at = now - d * DAY
  const missed = d === 1
  await db
    .prepare('INSERT INTO check_ins (id, monitor_id, status, started, finished, duration) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      hex(32),
      nightly,
      missed ? 'missed' : 'ok',
      at,
      missed ? null : at + 90_000,
      missed ? null : 60_000 + Math.floor(random() * 60_000),
    )
    .run()
}
await db
  .prepare("INSERT INTO incidents (monitor_id, opened_at, reason) VALUES (?, ?, 'missed')")
  .bind(nightly, now - DAY + 10 * MIN)
  .run()

// A week of transactions: 1.0 (10) shipped 3 days ago, and made exporting slower
const TRANSACTIONS = [
  [
    pocketband,
    'SongView',
    'ui.load',
    180,
    [
      ['file.read', 'song.json', 0.2],
      ['ui.render', 'PatternGrid', 0.5],
    ],
  ],
  [pocketband, 'app.start.cold', 'app.start', 650, [['app.init', 'AudioEngine.start', 0.6]]],
  [
    pocketband,
    'Export song',
    'task',
    2400,
    [
      ['audio.render', 'Studio.render', 0.8],
      ['file.write', 'song.m4a', 0.1],
    ],
  ],
  [sync, 'GET /songs', 'http.server', 45, [['db.query', 'SELECT * FROM songs WHERE owner = ?', 0.7]]],
  [
    sync,
    'PUT /songs/:id',
    'http.server',
    90,
    [
      ['db.query', 'INSERT INTO songs …', 0.5],
      ['http.client', 'R2 put', 0.3],
    ],
  ],
]
let transactions = 0
for (const [p, name, op, typical, parts] of TRANSACTIONS) {
  for (let i = 0; i < 180; i++) {
    const at = Math.round(now - random() * 7 * DAY)
    const newer = at > now - 3 * DAY
    const release = p === pocketband ? (newer ? '1.0 (10)' : '1.0 (9)') : ''
    const duration = Math.round(typical * (0.5 + random() ** 3 * 3) * (newer && name === 'Export song' ? 1.8 : 1))
    let start = Math.round(duration * 0.05)
    const spans = parts.map(([op, description, share]) => {
      const span = { op, description, start, duration: Math.round(duration * share * (0.8 + random() * 0.2)), depth: 0 }
      start += span.duration
      return span
    })
    const error = random() < 0.02
    const status = error ? 'internal_error' : 'ok'
    const traceId = traceOf(at)
    await storeTransaction(
      db,
      p.id,
      {
        id: hex(32),
        name,
        release,
        environment: 'production',
        op,
        status,
        error,
        traceId,
        timestamp: at,
        duration,
        spans,
        vitals: [],
      },
      at,
    )
    transactions++
  }
}
for (let d = 0; d < 14; d++) {
  const release = d < 3 ? '1.0 (10)' : '1.0 (9)'
  const started = 40 + Math.floor(random() * 30)
  const day = new Date(now - d * DAY).toISOString().slice(0, 10)
  const crashed = d < 3 ? 0 : 1 + Math.floor(random() * 2)
  await storeSessions(db, pocketband.id, [
    { release, environment: 'production', day, started, errored: Math.floor(started * 0.04), abnormal: 0, crashed },
  ])
}

const channel = await db
  .prepare(
    "INSERT INTO channels (kind, name, config, quiet_from, quiet_to, created_at) VALUES ('telegram', 'My phone', ?, 1320, 420, ?) RETURNING id",
  )
  .bind(JSON.stringify({ token: `1:${hex(16)}`, chat: '1', name: 'Me' }), now)
  .first()
await db
  .prepare(
    'INSERT INTO routes (kinds, environments, thresholds, channel_ids, created_at) VALUES (\'["new","regression","threshold","review_crash"]\', \'["production"]\', \'[10,100,1000]\', ?, ?)',
  )
  .bind(JSON.stringify([channel.id]), now)
  .run()

console.log(
  `${events.length} events in ${issueOf.size} issues, ${logs.length} logs and ${transactions} transactions, in 3 projects`,
)
await proxy.dispose()
await vite.close()
