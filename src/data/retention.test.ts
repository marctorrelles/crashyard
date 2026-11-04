import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { pruneLogs } from './logs'
import { markUsed } from '../symbols/symbolicate'
import { deleteProject, pruneEvents, pruneUploads } from './projects'

const DAY = 864e5
const NOW = Date.UTC(2026, 9, 26, 12)

describe('retention', () => {
  it('prunes 12,000 old events and 12,000 old logs in one run, with old issues and attachments, and keeps the rest', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    const old = NOW - 100 * DAY // past the default 90 days of events and 30 of logs
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, count) VALUES
        (1, 1, 'old', 'Old', ${old}, ${old}, 12000), (2, 1, 'new', 'New', ${old}, ${NOW}, 1);
      INSERT INTO issue_days (issue_id, day, count) VALUES (1, '2026-07-18', 12000), (2, '2026-10-26', 1);
      INSERT INTO issue_tag_values (issue_id, key, value, count, last_seen) VALUES (1, 'os', 'iOS', 1, ${old});
      INSERT INTO issue_activity (issue_id, kind, at) VALUES (1, 'created', ${old});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
        INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        SELECT printf('%032x', i), 1, 1, ${old}, ${old}, 'error', 'node', '{}' FROM n;
      INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        VALUES ('${'f'.repeat(32)}', 1, 2, ${NOW}, ${NOW}, 'error', 'node', '{}');
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12000)
        INSERT INTO logs (project_id, timestamp, received, level, body, attributes)
        SELECT 1, ${old}, ${old}, 'info', 'old', '{}' FROM n;
      INSERT INTO logs (project_id, timestamp, received, level, body, attributes) VALUES (1, ${NOW}, ${NOW}, 'info', 'new', '{}');
      INSERT INTO attachments (event_id, project_id, filename, size, r2_key, received) VALUES
        ('${'0'.repeat(31)}1', 1, 'old.png', 1, 'attachments/1/old.png', ${old}),
        ('${'f'.repeat(32)}', 1, 'new.png', 1, 'attachments/1/new.png', ${NOW});
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
        INSERT INTO attachments (event_id, project_id, filename, size, r2_key, received)
        SELECT printf('%032x', i + 1), 1, 'old.png', 1, printf('attachments/1/%d.png', i), ${old} FROM n;
      INSERT INTO issue_minutes (issue_id, minute, count) VALUES
        (2, ${Math.floor((NOW - 2 * DAY) / 60_000)}, 3), (2, ${Math.floor(NOW / 60_000)}, 1);
      INSERT INTO session_users_daily (project_id, release, environment, day, did_hash) VALUES
        (1, '1.0', 'production', '2026-07-18', 'a'), (1, '1.0', 'production', '2026-10-26', 'a');
      INSERT INTO session_crashes (project_id, sid, at) VALUES (1, 'old', ${NOW - 3 * DAY}), (1, 'new', ${NOW - DAY});
    `)
    await files.put('attachments/1/old.png', 'x')
    await files.put('attachments/1/new.png', 'x')
    const count = (table: string) => (db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

    const started = Date.now()
    const deadline = started + 20_000
    expect(await pruneEvents(db, NOW, files, deadline)).toEqual({
      events: 12000,
      attachments: 200,
      issues: 1,
      hours: 0,
      minutes: 1,
      sessionUsers: 1,
      sessionCrashes: 1,
    })
    expect(await pruneLogs(db, NOW, deadline)).toEqual({ logs: 12000 })
    expect(Date.now() - started).toBeLessThan(20_000)

    expect([count('events'), count('logs'), count('attachments'), count('issues')]).toEqual([1, 1, 1, 1])
    expect([count('issue_days'), count('issue_tag_values'), count('issue_activity')]).toEqual([1, 0, 0])
    expect([count('issue_minutes'), count('session_users_daily'), count('session_crashes')]).toEqual([1, 1, 1])
    expect([...files.objects.keys()]).toEqual(['attachments/1/new.png'])
  })

  it('stops at the deadline', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0)")
    expect(await pruneEvents(db, NOW, undefined, Date.now() - 1)).toEqual({
      events: 0,
      attachments: 0,
      issues: 0,
      hours: 0,
      minutes: 0,
      sessionUsers: 0,
      sessionCrashes: 0,
    })
  })
})

describe('deleting a project', () => {
  it('takes its rows in batches and its files in R2, and goes on from where a run out of time stopped', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'Big', 'k', 0), (2, 'b', 'Kept', 'k2', 0);
      INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen, count) VALUES (1, 1, 'f', 'I', 0, 0, 1);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500)
        INSERT INTO logs (project_id, timestamp, received, level, body, attributes) SELECT 1, 0, 0, 'info', 'x', '{}' FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
        INSERT INTO events (id, project_id, issue_id, timestamp, received, level, platform, data)
        SELECT printf('%032x', i), 1, 1, 0, 0, 'error', 'node', '{}' FROM n;
      INSERT INTO logs (project_id, timestamp, received, level, body, attributes) VALUES (2, 0, 0, 'info', 'kept', '{}');
    `)
    await files.put('attachments/1/e/0-shot.png', 'x')
    await files.put('envelopes/1/2026-10-28/e', 'x')
    await files.put('attachments/2/e/0-shot.png', 'x')
    await expect(deleteProject(db, files, 1, Date.now() - 1)).rejects.toThrow('Delete it again to go on')
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 2 })
    await deleteProject(db, files, 1)
    const count = (sql: string) => (db.sqlite.prepare(sql).get() as { n: number }).n
    expect([count('SELECT COUNT(*) AS n FROM projects'), count('SELECT COUNT(*) AS n FROM logs')]).toEqual([1, 1])
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(0)
    expect([...files.objects.keys()]).toEqual(['attachments/2/e/0-shot.png'])
  })
})

describe('debug file retention', () => {
  const old = NOW - 100 * DAY // past the default 90 days
  const debugFile = (
    id: number,
    debugId: string,
    checksum: string,
    at: number,
    { project = 1, name = 'App', arch = 'arm64' as string | null, kind = 'macho', used = null as number | null } = {},
  ) =>
    `INSERT INTO debug_files (id, project_id, checksum, name, debug_id, arch, kind, file_key, symcache_key, size, created_at, last_used_at)
     VALUES (${id}, ${project}, '${checksum}', '${name}', '${debugId}', ${arch ? `'${arch}'` : 'NULL'}, '${kind}',
       'debug-files/${project}/${checksum}', 'symcaches/${project}/${debugId}/${checksum}', 1, ${at}, ${used ?? 'NULL'});`
  const keys = (files: { objects: Map<string, unknown> }) => [...files.objects.keys()].sort()
  const ids = (db: ReturnType<typeof sqliteD1>, table: string) =>
    (db.sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map((r) => r.id)

  it('deletes an old unused file with its SymCache, keeps a used one and the newest of each name and arch', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at, debug_file_retention_days)
        VALUES (1, 'a', 'a', 'k', 0, 90), (2, 'b', 'b', 'k2', 0, 7);
      ${debugFile(1, 'a', 'fat', old - 2 * DAY)}
      ${debugFile(2, 'b', 'c2', old - DAY, { used: NOW - 10 * DAY })}
      ${debugFile(3, 'c', 'c3', old - DAY / 2)}
      ${debugFile(11, 'c', 'c3b', old)}
      ${debugFile(12, 'c', 'c3c', old)}
      ${debugFile(4, 'ax', 'fat', old - 2 * DAY, { arch: 'x86_64' })}
      ${debugFile(5, 'p1', 'm1', old - DAY, { name: '/proguard/p1.txt', arch: null, kind: 'proguard' })}
      ${debugFile(6, 'p2', 'm2', old, { name: '/proguard/p2.txt', arch: null, kind: 'proguard' })}
      ${debugFile(7, 'w1', 'w1', NOW - 10 * DAY, { project: 2, name: 'Widget' })}
      ${debugFile(8, 'w2', 'w2', NOW - 9 * DAY, { project: 2, name: 'Widget' })}
      ${debugFile(9, 'r1', 'r1', NOW - 10 * DAY, { name: 'Recent' })}
      ${debugFile(10, 'r2', 'r2', NOW - 9 * DAY, { name: 'Recent' })}
    `)
    const rows = db.sqlite.prepare('SELECT file_key, symcache_key FROM debug_files').all() as Record<string, string>[]
    for (const r of rows) await Promise.all([files.put(r.file_key, 'x'), files.put(r.symcache_key, 'x')])

    expect(await pruneUploads(db, files, NOW)).toEqual({ debugFiles: 4, bundles: 0 })
    // 1: old and unused, a newer build of App arm64 came; 3: the same debug id uploaded again, which lookups read
    // instead; 5: an older mapping; 7: past project b's 7 days. 11 and 12, one upload, are both the newest
    expect(ids(db, 'debug_files')).toEqual([2, 4, 6, 8, 9, 10, 11, 12])
    expect(keys(files)).toEqual(
      [
        'debug-files/1/fat', // still x86_64's, the newest of its arch
        'debug-files/1/c2',
        'debug-files/1/c3b',
        'debug-files/1/c3c',
        'debug-files/1/m2',
        'debug-files/1/r1',
        'debug-files/1/r2',
        'debug-files/2/w2',
        'symcaches/1/b/c2',
        'symcaches/1/c/c3b',
        'symcaches/1/c/c3c',
        'symcaches/1/ax/fat',
        'symcaches/1/p2/m2',
        'symcaches/1/r1/r1',
        'symcaches/1/r2/r2',
        'symcaches/2/w2/w2',
      ].sort(),
    )
    expect(await pruneUploads(db, files, NOW)).toEqual({ debugFiles: 0, bundles: 0 })
  })

  it('deletes in batches R2 takes, 1000 keys at most', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
        INSERT INTO debug_files (project_id, checksum, name, debug_id, arch, kind, file_key, symcache_key, size, created_at)
        SELECT 1, 'c' || i, 'App', 'd' || i, 'arm64', 'macho', 'debug-files/1/c' || i, 'symcaches/1/d' || i, 1, ${old} + i FROM n;
    `)
    for (let i = 1; i <= 1200; i++)
      await Promise.all([files.put(`debug-files/1/c${i}`, 'x'), files.put(`symcaches/1/d${i}`, 'x')])
    expect(await pruneUploads(db, files, NOW)).toEqual({ debugFiles: 1199, bundles: 0 })
    expect(keys(files)).toEqual(['debug-files/1/c1200', 'symcaches/1/d1200'])
  })

  it('deletes old unused bundles of a package once a newer release of it came, and keeps shared files', async () => {
    const db = sqliteD1()
    const files = memoryR2()
    const bundle = (id: number, project: number, checksum: string, release: string | null, at: number, used = 'NULL') =>
      `INSERT INTO artifact_bundles (id, project_id, checksum, release, file_key, size, created_at, last_used_at)
       VALUES (${id}, ${project}, '${checksum}', ${release ? `'${release}'` : 'NULL'}, 'bundles/${checksum}', 1, ${at}, ${used});
       INSERT INTO artifact_files (bundle_id, project_id, debug_id, type, path, cache_key, cache_offset, cache_length)
       VALUES (${id}, ${project}, 'id${id}', 'minified_source', 'a.js', 'smcaches/${checksum}', 0, 1);`
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0), (2, 'b', 'b', 'k2', 0);
      ${bundle(1, 1, 'web1', 'web@1', old - 3 * DAY)}
      ${bundle(2, 1, 'web2', 'web@2', old - 2 * DAY, String(NOW - DAY))}
      ${bundle(3, 1, 'web3', 'web@3', old)}
      ${bundle(4, 1, 'worker1', 'worker@1', old - 4 * DAY)}
      ${bundle(5, 1, 'shared', 'web@0', old - 5 * DAY)}
      ${bundle(6, 2, 'shared', 'web@0', NOW)}
      INSERT INTO artifact_files (bundle_id, project_id, debug_id, type, path, cache_key)
        VALUES (1, 1, 'old', 'minified_source', 'b.js', 'smcaches/web1/b.js');
    `)
    for (const k of (
      db.sqlite
        .prepare('SELECT file_key AS k FROM artifact_bundles UNION SELECT cache_key FROM artifact_files')
        .all() as {
        k: string
      }[]
    ).map((r) => r.k))
      await files.put(k, 'x')

    expect(await pruneUploads(db, files, NOW)).toEqual({ debugFiles: 0, bundles: 2 })
    // 1: web@1, older than web@3; 5: also project b's, so its files stay; 2 was used, 3 and 4 are the newest
    expect(ids(db, 'artifact_bundles')).toEqual([2, 3, 4, 6])
    expect(db.sqlite.prepare('SELECT bundle_id FROM artifact_files ORDER BY bundle_id').all()).toEqual(
      [2, 3, 4, 6].map((bundle_id) => ({ bundle_id })),
    )
    expect(keys(files)).toEqual(
      ['bundles/web2', 'bundles/web3', 'bundles/worker1', 'bundles/shared']
        .concat(['smcaches/web2', 'smcaches/web3', 'smcaches/worker1', 'smcaches/shared'])
        .sort(),
    )
  })

  it('notes a lookup at most once a day a row', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'k', 0);
      ${debugFile(1, 'a', 'c1', old)}
    `)
    const writes: string[] = []
    const watched = {
      ...db,
      prepare: (sql: string) => (writes.push(sql), db.prepare(sql)),
    } as unknown as D1Database
    const usedAt = () =>
      (db.sqlite.prepare('SELECT last_used_at AS t FROM debug_files').get() as { t: number | null }).t
    const row = { id: 1, last_used_at: null as number | null }

    await markUsed(watched, 'debug_files', [row], NOW)
    expect([usedAt(), row.last_used_at, writes.length]).toEqual([NOW, NOW, 1])
    // The same row again, and a fresh read of it, within the day: no statement
    await markUsed(watched, 'debug_files', [row], NOW + DAY - 1)
    await markUsed(watched, 'debug_files', [{ id: 1, last_used_at: NOW }], NOW + 1000)
    expect(writes.length).toBe(1)
    // Another isolate's stale copy: the statement's guard writes nothing
    await markUsed(watched, 'debug_files', [{ id: 1, last_used_at: null }], NOW + 1000)
    expect([usedAt(), writes.length]).toEqual([NOW, 2])
    // A day on, it moves
    await markUsed(watched, 'debug_files', [row], NOW + DAY)
    expect(usedAt()).toBe(NOW + DAY)
  })
})
