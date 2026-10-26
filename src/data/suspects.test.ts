import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import type { NormalizedEvent } from '../ingest/event'
import { fixedIssues, storeCommits } from './source'
import { similarIssues, suspectCommits } from './suspects'

const REPO = 'https://github.com/marc/pocketband'
const crash = (frames: NormalizedEvent['exceptions'][number]['frames'], type = 'EXC_BAD_ACCESS') =>
  ({ exceptions: [{ type, value: 'x', frames }] }) as unknown as NormalizedEvent

function setup() {
  const db = sqliteD1()
  db.sqlite.exec(`INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'App', 'k', 0);
    INSERT INTO releases (project_id, version, created_at) VALUES (1, '1.2', 0);`)
  return db
}
const commits = [
  {
    id: 'c3',
    message: 'Retry the player when audio drops',
    author_name: 'Marc',
    timestamp: '2026-10-20T10:00:00Z',
    patch_set: [{ path: 'apple/Sources/Player.swift', type: 'M' }],
  },
  { id: 'c2', message: 'Copy', patch_set: [{ path: 'apple/Sources/Strings.swift', type: 'M' }] },
  {
    id: 'c1',
    message: 'Add the player',
    patch_set: [
      { path: 'apple/Sources/Player.swift', type: 'A' },
      { path: 'apple/Sources/Mixer.swift', type: 'A' },
    ],
  },
]

describe('suspect commits', () => {
  it('are the first release’s commits that touched a top in-app frame’s file, newest first', async () => {
    const db = setup()
    await storeCommits(db, '1.2', commits)
    const event = crash([
      { inApp: false, function: 'objc_msgSend', package: '/usr/lib/libobjc.dylib' },
      { inApp: true, function: 'Player.play()', absPath: '/Users/ci/build/apple/Sources/Player.swift', lineno: 40 },
    ])
    const suspects = await suspectCommits(db, { project_id: 1, first_release: '1.2' }, event, REPO)
    expect(suspects.map((c) => c.sha)).toEqual(['c3', 'c1'])
    expect(suspects[0]).toMatchObject({
      author: 'Marc',
      url: `${REPO}/commit/c3`,
      files: ['apple/Sources/Player.swift'],
    })
    // Another release, or a release whose commits came without files, has none
    expect(await suspectCommits(db, { project_id: 1, first_release: '1.1' }, event, REPO)).toEqual([])
    const bare = setup()
    await storeCommits(
      bare,
      '1.2',
      commits.map(({ patch_set: _, ...c }) => c),
    )
    expect(await suspectCommits(bare, { project_id: 1, first_release: '1.2' }, event, REPO)).toEqual([])
  })
})

describe('resolving by commit', () => {
  it('reads Fixes CRASHYARD-<id> and fixes crashyard#<id>', () => {
    expect(fixedIssues('Guard the mixer\n\nFixes CRASHYARD-12, fixes crashyard#7 and fixes crashyard#7')).toEqual([
      12, 7,
    ])
    expect(fixedIssues('Prefixes CRASHYARD-3')).toEqual([])
  })

  it('resolves the issue in that release once, naming the commit', async () => {
    const db = setup()
    db.sqlite.exec(`INSERT INTO issues (id, project_id, fingerprint, title, first_seen, last_seen) VALUES
      (12, 1, 'a', 'Crash', 0, 0), (13, 1, 'b', 'Other', 0, 0)`)
    const fix = [{ id: 'f1', message: 'Guard the mixer\n\nFixes CRASHYARD-12', patch_set: [] }]
    await storeCommits(db, '1.2', fix, null, 5)
    await storeCommits(db, '1.2', fix, null, 6) // sent again: no second entry
    expect(
      db.sqlite.prepare('SELECT status, fixed_in_release, resolved_in_commit FROM issues WHERE id = 12').get(),
    ).toEqual({ status: 'resolved', fixed_in_release: '1.2', resolved_in_commit: 'f1' })
    expect(db.sqlite.prepare("SELECT data FROM issue_activity WHERE kind = 'resolved'").all()).toEqual([
      { data: JSON.stringify({ release: '1.2', commit: { sha: 'f1', message: 'Guard the mixer' } }) },
    ])
    expect(db.sqlite.prepare('SELECT status FROM issues WHERE id = 13').get()).toEqual({ status: 'unresolved' })
  })
})

describe('similar issues', () => {
  it('share the exception type and top in-app function under another fingerprint', async () => {
    const db = setup()
    db.sqlite
      .exec(`INSERT INTO issues (id, project_id, fingerprint, title, culprit, first_seen, last_seen, count) VALUES
      (1, 1, 'a', 'EXC_BAD_ACCESS: KERN_INVALID_ADDRESS', 'Player in play()', 0, 0, 5),
      (2, 1, 'b', 'EXC_BAD_ACCESS: other address', 'Player in play()', 0, 0, 9),
      (3, 1, 'c', 'EXC_BAD_ACCESS', 'Player in play()', 0, 0, 1),
      (4, 1, 'd', 'EXC_BAD_ACCESSORY: x', 'Player in play()', 0, 0, 1),
      (5, 1, 'e', 'EXC_BAD_ACCESS: x', 'Mixer in mix()', 0, 0, 1)`)
    const issue = { id: 1, project_id: 1, culprit: 'Player in play()', type: 'error' }
    expect((await similarIssues(db, issue, crash([]))).map((i) => i.id)).toEqual([2, 3])
    expect(await similarIssues(db, { ...issue, type: 'message' }, crash([]))).toEqual([])
  })
})
