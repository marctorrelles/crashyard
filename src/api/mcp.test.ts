import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { type Role, tokenRole } from '../data/people'
import { normalizeEvent } from '../ingest/event'
import { type Project, storeEvent } from '../ingest/store'
import { handleMcp } from './mcp'

const NOW = Date.UTC(2026, 9, 26, 12)

describe('MCP for agents', () => {
  it('changes issues with an agent token only as far as its scope and its person’s role go', async () => {
    const db = sqliteD1()
    db.sqlite.exec("INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'p', 'p', 'k', 0)")
    const project = { id: 1, slug: 'p', name: 'p' } as Project
    const stored = (await storeEvent(db, project, await normalizeEvent({ message: 'boom' }, NOW), 'one'))!
    const note = async (role: Role) => {
      const request = new Request('https://x/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'add_note', arguments: { id: stored.issue.id, text: 'looked' } },
        }),
      })
      const answer = (await (await handleMcp(request, db, { email: 'ada@example.com', role })).json()) as {
        result: { isError?: boolean; content: { text: string }[] }
      }
      return answer.result
    }
    expect((await note(tokenRole('owner', 'read'))).content[0].text).toMatch(/can only read/)
    expect((await note(tokenRole('viewer', 'change'))).isError).toBe(true)
    expect((await note(tokenRole('admin', 'change'))).isError).toBeFalsy()
  })
})
