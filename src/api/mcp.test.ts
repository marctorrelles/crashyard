import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { AGENTS_KEY, setSetting } from '../data/settings'
import { normalizeEvent } from '../ingest/event'
import { type Project, storeEvent } from '../ingest/store'
import { handleMcp } from './mcp'

const NOW = Date.UTC(2026, 9, 26, 12)

describe('MCP for agents', () => {
  it('can’t resolve an issue through MCP until "Let agents change issues" is on', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'p', 'p', 'k', 0)")
    const project = { id: 1, slug: 'p', name: 'p' } as Project
    const stored = (await storeEvent(db, project, await normalizeEvent({ message: 'boom' }, NOW), 'one'))!
    const resolve = async (viewer: string) => {
      const request = new Request('https://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'resolve_issue', arguments: { id: stored.issue.id } },
        }),
      })
      return ((await (await handleMcp(request, db, viewer)).json()) as { result: { isError?: boolean } }).result
    }
    const status = () => (db.sqlite.prepare('SELECT status FROM issues').get() as { status: string }).status
    expect((await resolve('service:bot')).isError).toBe(true)
    expect(status()).toBe('unresolved')
    await setSetting(db, AGENTS_KEY, true, 'me', NOW)
    expect((await resolve('service:bot')).isError).toBeFalsy()
    expect(status()).toBe('resolved')
  })
})
