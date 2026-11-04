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

  const call = async (
    db: ReturnType<typeof sqliteD1>,
    name: string,
    args: Record<string, unknown>,
    role: Role = 'member',
  ) => {
    const request = new Request('https://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const answer = (await (await handleMcp(request, db, { email: 'ada@example.com', role })).json()) as {
      result: { isError?: boolean; content: { text: string }[] }
    }
    return { error: !!answer.result.isError, text: answer.result.content[0].text }
  }

  async function seeded() {
    const db = sqliteD1()
    db.sqlite.exec(`
      INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'App', 'k', 0);
      INSERT INTO monitors (id, project_id, slug, name, kind, config, status, created_at) VALUES
        (1, 1, 'api', 'API', 'uptime', '{"url":"https://api.example"}', 'ok', 0);
      INSERT INTO uptime_results (monitor_id, at, ok, error) VALUES (1, ${Date.now() - 60_000}, 1, NULL);
      INSERT INTO status_pages (id, slug, name, created_at) VALUES (1, 'all', 'All services', 0);
      INSERT INTO status_page_monitors (page_id, monitor_id) VALUES (1, 1);
    `)
    const project = { id: 1, slug: 'app', name: 'App' } as Project
    const now = Date.now()
    const store = async (message: string, release: string, os: string) =>
      (await storeEvent(
        db,
        project,
        await normalizeEvent(
          {
            message,
            release,
            tags: { os },
            timestamp: now / 1000,
            contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) } },
          },
          now,
        ),
        message,
      ))!.issue.id
    return {
      db,
      ids: [
        await store('boom', '1.0', 'iOS'),
        await store('bang', '1.1', 'Android'),
        await store('bang 2', '1.1', 'iOS'),
      ],
    }
  }

  it('names itself with a title and an icon', async () => {
    const request = new Request('https://cy.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    })
    const { result } = (await (
      await handleMcp(request, sqliteD1(), { email: 'ada@example.com', role: 'viewer' })
    ).json()) as {
      result: { serverInfo: { title: string; websiteUrl: string; icons: { src: string; mimeType: string }[] } }
    }
    expect(result.serverInfo).toMatchObject({ title: 'crashyard', websiteUrl: 'https://cy.example' })
    expect(result.serverInfo.icons[0].src).toMatch(/^(data:image\/svg\+xml|https:\/\/cy\.example\/)/)
  })

  it('answers every read tool with text, on data and on none', async () => {
    const { db, ids } = await seeded()
    const reads: [string, Record<string, unknown>, RegExp][] = [
      ['list_projects', {}, /^app · App/],
      ['search_issues', {}, /boom/],
      ['get_issue', { id: ids[0] }, /events per day, last 14: \d\d-\d\d 1/],
      ['list_issue_events', { id: ids[0], tags: ['os'] }, /release=1\.0 environment=- os=iOS/],
      ['search_events', { group_by: 'os' }, /- iOS: 2\n- Android: 1/],
      ['search_events', { query: 'release:1.1' }, /^2 events/],
      ['get_trace', { trace: 'a'.repeat(32) }, /## Errors\n.*boom/],
      ['list_releases', { project: 'app' }, /1\.1 · first/],
      ['get_release', { project: 'app', release: '1.1' }, /## New in this release\n- #\d+ bang/],
      ['list_transactions', { project: 'app' }, /No transactions/],
      ['list_monitors', {}, /#1 \[app\] API · uptime check · ok/],
      ['get_monitor', { id: 1 }, /## Latest results\n- .* ok/],
      ['list_status_pages', {}, /slug all.*\nchecks: #1 API \(App, ok\)/],
    ]
    for (const [name, args, expected] of reads) {
      const r = await call(db, name, args, 'viewer')
      expect(r.error, `${name}: ${r.text}`).toBe(false)
      expect(r.text, `${name}: ${r.text}`).toMatch(expected)
    }
    const empty = sqliteD1()
    for (const name of ['list_projects', 'search_issues', 'list_monitors', 'list_status_pages'])
      expect((await call(empty, name, {}, 'viewer')).error).toBe(false)
    expect((await call(db, 'list_releases', { project: 'nope' })).text).toMatch(/No project nope/)
  })

  it("searches issues as the token's person: is:bookmarked and assigned:me are theirs", async () => {
    const { db, ids } = await seeded()
    db.sqlite.exec(`INSERT INTO bookmarks (email, issue_id) VALUES ('ada@example.com', ${ids[1]})`)
    db.sqlite.exec(`UPDATE issues SET assignee = 'ada@example.com' WHERE id = ${ids[2]}`)
    const bookmarked = await call(db, 'search_issues', { query: 'is:bookmarked' }, 'viewer')
    expect(bookmarked.text).toMatch(new RegExp(`^#${ids[1]} .*bang ·`))
    expect(bookmarked.text.split('\n')).toHaveLength(1)
    expect((await call(db, 'search_issues', { query: 'assigned:me' }, 'viewer')).text).toMatch(/bang 2/)
    expect((await call(db, 'search_issues', { sort: 'constructor' }, 'viewer')).error).toBe(false)
  })

  it('triages issues and posts to a status page, and a read token can do none of it', async () => {
    const { db, ids } = await seeded()
    const changes: [string, Record<string, unknown>][] = [
      ['resolve_issue', { ids: ids.slice(0, 2), in_release: '1.2' }],
      ['reopen_issue', { id: ids[0] }],
      ['set_priority', { ids, priority: 'high' }],
      ['assign_issue', { id: ids[0], to: 'me' }],
      ['link_issue', { id: ids[0], url: 'https://github.com/o/r/issues/1' }],
      ['merge_issues', { ids: [ids[1], ids[2]] }],
      ['ignore_issue', { id: ids[1], until_escalating: true }],
      ['post_status_update', { page: 'all', kind: 'minor', title: 'Slow API', message: 'Looking', affects: [1] }],
    ]
    const replies: Record<string, string> = {}
    for (const [name, args] of changes) {
      expect((await call(db, name, args, 'viewer')).text, name).toMatch(/can only read/)
      const r = await call(db, name, args)
      expect(r.error, `${name}: ${r.text}`).toBe(false)
      replies[name] = r.text
    }
    expect(replies.merge_issues).toBe(`Merged into #${ids[1]}.`)
    const issue = (id: number) =>
      db.sqlite
        .prepare('SELECT status, fixed_in_release, priority, assignee, external_url FROM issues WHERE id = ?')
        .get(id)
    expect(issue(ids[0])).toEqual({
      status: 'unresolved',
      fixed_in_release: null,
      priority: 'high',
      assignee: 'ada@example.com',
      external_url: 'https://github.com/o/r/issues/1',
    })
    expect(issue(ids[2])).toBeUndefined()
    expect((issue(ids[1]) as { status: string }).status).toBe('ignored')
    const post = (await call(db, 'list_status_pages', {})).text.match(
      /post (\d+): Slow API · Some services affected · open/,
    )
    expect(post).not.toBeNull()
    expect(
      (await call(db, 'post_status_update', { post: Number(post![1]), state: 'resolved', message: 'Fixed' })).text,
    ).toMatch(/Resolved/)
    expect((await call(db, 'post_status_update', { page: 'all', kind: 'minor', message: 'x' })).text).toMatch(
      /title is required/,
    )
  })
})
