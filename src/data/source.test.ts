import { describe, expect, it } from 'vitest'
import { codeUrl, commitUrl, indexFiles, linksOf, matchFile, repoUrl } from './source'

const files = indexFiles([
  'apple/Studio.swift',
  'apple/Sync/Sync.swift',
  'android/app/src/main/java/com/example/app/Studio.kt',
  'android/app/src/main/java/com/example/app/Sync.kt',
  'web/app/sync.ts',
  'web/app/studio.ts',
  'engine/src/voice.cpp',
  'engine/src/util.h',
  'tools/util.h',
])

describe('matchFile', () => {
  it.each([
    [
      'an Apple build path, from any checkout',
      { absPath: '/Users/dev/code/app/apple/Studio.swift' },
      'apple/Studio.swift',
    ],
    [
      'a worktree',
      { absPath: '/Users/dev/code/app/.claude/worktrees/x/apple/Sync/Sync.swift' },
      'apple/Sync/Sync.swift',
    ],
    [
      'Kotlin, by its package',
      { module: 'com.example.app.Studio$play$1', filename: 'Studio.kt' },
      'android/app/src/main/java/com/example/app/Studio.kt',
    ],
    ['a source-mapped web file', { filename: 'webpack://_N_E/./app/sync.ts' }, 'web/app/sync.ts'],
    ['an app:// path', { absPath: 'app:///web/app/studio.ts' }, 'web/app/studio.ts'],
    ['native code', { absPath: '/Users/dev/code/app/engine/src/voice.cpp' }, 'engine/src/voice.cpp'],
    ['the better of two of a name', { absPath: '/x/engine/src/util.h' }, 'engine/src/util.h'],
  ])('%s', (_, frame, path) => expect(matchFile(files, frame)).toBe(path))

  it.each([
    ['two of a name match as well', { filename: 'util.h' }],
    ['no file has its name', { absPath: '/usr/include/stdio.h' }],
    ['nothing to go by', {}],
  ])('none when %s', (_, frame) => expect(matchFile(files, frame)).toBeNull())
})

describe('links', () => {
  it('builds GitHub and GitLab URLs, the path encoded', () => {
    expect(codeUrl('https://github.com/o/r', 'abc', 'a b/c.ts', 12)).toBe(
      'https://github.com/o/r/blob/abc/a%20b/c.ts#L12',
    )
    expect(codeUrl('https://gitlab.com/o/r', 'abc', 'c.ts')).toBe('https://gitlab.com/o/r/-/blob/abc/c.ts')
    expect(commitUrl('https://github.com/o/r', 'abc')).toBe('https://github.com/o/r/commit/abc')
  })

  it('links in-app frames only, by their indexes in the event', () => {
    const frames = [
      { inApp: false, absPath: '/x/apple/Studio.swift' },
      { inApp: true, absPath: '/x/apple/Studio.swift', lineno: 3 },
    ]
    const event = { exceptions: [{ type: 'E', value: '', frames }] } as unknown as Parameters<typeof linksOf>[0]
    expect(linksOf(event, files, 'https://github.com/o/r', 'abc')).toEqual({
      '0.1': 'https://github.com/o/r/blob/abc/apple/Studio.swift#L3',
    })
  })

  it('reads a repository address', () => {
    expect(repoUrl(' https://github.com/o/r.git/ ')).toBe('https://github.com/o/r')
    expect(repoUrl('')).toBeNull()
    expect(() => repoUrl('github.com/o/r')).toThrow()
    expect(() => repoUrl('http://github.com/o/r')).toThrow()
    expect(() => repoUrl('https://github.com/o')).toThrow()
  })
})
