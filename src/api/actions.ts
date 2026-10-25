// POST /api/actions/<issue>/<resolve|ignore>?expires=…&signature=…: what a push's buttons call, without signing in.
import { type IssueAction, verifyAction } from '../notify/actions'

export async function handleAction(
  request: Request,
  env: { DB: D1Database; ACTION_SECRET?: string },
  issueId: number,
  action: IssueAction,
) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const url = new URL(request.url)
  const valid =
    !!env.ACTION_SECRET &&
    (await verifyAction(
      env.ACTION_SECRET,
      issueId,
      action,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('signature') ?? '',
    ))
  if (!valid) return new Response('This link has expired or isn’t valid', { status: 403 })
  const now = Date.now()
  const [status, substatus] = action === 'resolve' ? ['resolved', null] : ['ignored', 'for_good']
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE issues SET status = ?, substatus = ?, resolved_in_release = NULL, ignore_until = NULL, ignore_until_count = NULL WHERE id = ?',
    ).bind(status, substatus, issueId),
    env.DB.prepare('INSERT INTO issue_activity (issue_id, kind, data, by, at) VALUES (?, ?, ?, ?, ?)').bind(
      issueId,
      action === 'resolve' ? 'resolved' : 'ignored',
      JSON.stringify({ from: 'notification' }),
      'a notification',
      now,
    ),
  ])
  return new Response(action === 'resolve' ? 'Resolved' : 'Ignored')
}
