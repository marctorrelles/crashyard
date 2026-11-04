import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { debugFilesFor } from './symbolicate'

describe('the file a debug id symbolicates with', () => {
  it('is one with debug info over a newer, larger symbol table, then the larger among files of unknown kind', async () => {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'a', 'a', 'ka', 0);
      INSERT INTO debug_files (project_id, checksum, name, debug_id, kind, file_key, size, debug_info, created_at) VALUES
        (1, 'dsym', 'App', 'a', 'macho', 'dsym', 120, 1, 1),
        (1, 'exe', 'App', 'a', 'macho', 'exe', 200, 0, 2),
        (1, 'old-exe', 'App', 'b', 'macho', 'old-exe', 70, NULL, 1),
        (1, 'old-dsym', 'App', 'b', 'macho', 'old-dsym', 120, NULL, 1),
        -- A target whose code didn't change: its executable sent again by a later build, its dSYM not
        (1, 'watch-dsym', 'Watch', 'c', 'macho', 'watch-dsym', 120, NULL, 1),
        (1, 'watch-exe', 'Watch', 'c', 'macho', 'watch-exe', 70, NULL, 1),
        (1, 'watch-exe-2', 'Watch', 'c', 'macho', 'watch-exe-2', 70, NULL, 2);
    `)
    const files = await debugFilesFor(db, 1, ['a', 'b', 'c'])
    expect(files.get('a')?.file_key).toBe('dsym')
    expect(files.get('b')?.file_key).toBe('old-dsym')
    expect(files.get('c')?.file_key).toBe('watch-dsym')
  })
})
