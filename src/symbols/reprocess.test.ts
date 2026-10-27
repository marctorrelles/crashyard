import { describe, expect, it } from 'vitest'
import { memoryR2, sqliteD1 } from '../../test/fakes'
import { normalizeEvent } from '../ingest/event'
import { fingerprintOf } from '../ingest/grouping'
import { groupingFor, type Project, storeEvent } from '../ingest/store'
import { reprocess } from './reprocess'

const NOW = Date.UTC(2026, 9, 26, 12)
const DEBUG_ID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9'

describe('reprocessing', () => {
  it('groups by the project’s rules, as ingest does, when a debug file comes late', async () => {
    const env = { DB: sqliteD1(), FILES: memoryR2() }
    env.DB.sqlite.exec(`INSERT INTO projects (id, slug, name, public_key, created_at, grouping_rules)
      VALUES (1, 'a', 'a', 'k', 0, 'error.type:TimeoutError -> timeouts')`)
    const project = env.DB.sqlite.prepare('SELECT * FROM projects').get() as unknown as Project
    const payload = {
      exception: { values: [{ type: 'TimeoutError', value: `waited on ${DEBUG_ID}` }] },
      debug_meta: { images: [{ type: 'macho', debug_id: DEBUG_ID }] },
    }
    const event = await normalizeEvent(payload, NOW)
    const { fingerprint, version } = await groupingFor(env.DB, project, event, NOW)
    expect(fingerprint).not.toBe(await fingerprintOf(await normalizeEvent(payload, NOW)))
    await storeEvent(env.DB, project, event, fingerprint, undefined, version)
    await reprocess(env, () => Promise.reject(new Error('no symbols needed')), 1, [DEBUG_ID], NOW)
    expect(env.DB.sqlite.prepare('SELECT fingerprint FROM issues').get()).toEqual({ fingerprint })
    expect(env.DB.sqlite.prepare('SELECT fingerprint, grouping_version FROM events').get()).toEqual({
      fingerprint,
      grouping_version: version,
    })
  })
})
