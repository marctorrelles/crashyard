import { afterEach, describe, expect, it, vi } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { handleTelegram } from './telegram'

const NOW = Date.UTC(2026, 9, 27, 12)

function setup() {
  const db = sqliteD1()
  const config = (chat: string, token = '111:aaa') =>
    JSON.stringify({ token, chat, secret: 'right', owner: 'marc@example.com' }).replace(/'/g, "''")
  db.sqlite.exec(`
    INSERT INTO projects (id, slug, name, public_key, created_at) VALUES (1, 'app', 'App', 'k1', 0);
    INSERT INTO issues (id, project_id, fingerprint, title, culprit, type, level, platform, status, first_seen, last_seen) VALUES
      (7, 1, 'a', 'Crash', '', 'error', 'error', 'cocoa', 'unresolved', 0, 0);
    INSERT INTO channels (kind, name, config, created_at) VALUES ('telegram', 'Mine', '${config('42')}', 0),
      ('telegram', 'Other bot', '${config('42', '222:bbb')}', 0);
  `)
  const calls: { method: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ method: url.split('/').pop()!, body: JSON.parse(String(init.body)) })
      return Response.json({ ok: true, result: true })
    }),
  )
  const tap = (data: string, { secret = 'right', chat = 42, bot = '111' } = {}) =>
    handleTelegram(
      new Request(`https://x/api/telegram/${bot}`, {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify({
          callback_query: {
            id: 'q1',
            data,
            from: { first_name: 'Marc' },
            message: {
              message_id: 5,
              chat: { id: chat },
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: 'Resolve', callback_data: 'r:7' },
                    { text: 'Ignore', callback_data: 'i:7' },
                    { text: 'Assign to me', callback_data: 'a:7' },
                  ],
                  [{ text: 'Open in crashyard', url: 'https://x/issues/7' }],
                ],
              },
            },
          },
        }),
      }),
      db,
      bot,
      NOW,
    )
  const issue = () => db.sqlite.prepare('SELECT status, substatus, assignee FROM issues WHERE id = 7').get()
  return { db, tap, calls, issue }
}

afterEach(() => vi.unstubAllGlobals())

describe('Telegram’s buttons', () => {
  it('refuse a wrong secret, and act only for the channel’s own chat', async () => {
    const { tap, calls, issue } = setup()
    expect((await tap('r:7', { secret: 'wrong' })).status).toBe(403)
    // Another bot's channel shares the chat, but this bot's secret only opens this bot's channels
    expect((await tap('r:7', { bot: '333' })).status).toBe(403)
    expect((await tap('r:7', { chat: 99 })).status).toBe(200)
    expect(issue()).toMatchObject({ status: 'unresolved' })
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
  })

  it('resolve, ignore and assign as the channel’s owner, and say so on the message', async () => {
    const { db, tap, calls, issue } = setup()
    expect((await tap('a:7')).status).toBe(200)
    expect(issue()).toMatchObject({ assignee: 'marc@example.com' })
    expect(calls.at(-1)).toMatchObject({
      method: 'editMessageReplyMarkup',
      body: {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Resolve' }, { text: 'Ignore' }, { text: '✓ Assigned to you', callback_data: 'done' }],
            [{ text: 'Open in crashyard' }],
          ],
        },
      },
    })
    await tap('i:7')
    expect(issue()).toMatchObject({ status: 'ignored', substatus: 'until_escalating' })
    await tap('r:7')
    expect(issue()).toMatchObject({ status: 'resolved' })
    expect(calls.at(-1)?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: '✓ Resolved' }], [{ text: 'Open in crashyard' }]] },
    })
    expect(calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text)).toEqual([
      'Assigned to you',
      'Ignored until it escalates',
      'Resolved',
    ])
    expect(db.sqlite.prepare('SELECT kind, by FROM issue_activity WHERE issue_id = 7 ORDER BY id').all()).toEqual([
      { kind: 'assigned', by: 'marc@example.com' },
      { kind: 'ignored', by: 'marc@example.com' },
      { kind: 'resolved', by: 'marc@example.com' },
    ])
  })

  it('say when the issue is gone', async () => {
    const { db, tap, calls } = setup()
    db.sqlite.exec('DELETE FROM issues WHERE id = 7')
    expect((await tap('r:7')).status).toBe(200)
    expect(calls).toEqual([
      { method: 'answerCallbackQuery', body: { callback_query_id: 'q1', text: 'That issue no longer exists' } },
    ])
  })
})
