// Signed links for the push's resolve and ignore buttons: they work without signing in, for that one issue and that
// one action, until they expire. The secret is the worker's ACTION_SECRET.

export type IssueAction = 'resolve' | 'ignore'
const WEEK = 7 * 86_400_000

async function key(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])
}
const message = (issueId: number, action: IssueAction, expires: number) =>
  new TextEncoder().encode(`${issueId}.${action}.${expires}`)
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function actionUrl(
  origin: string,
  secret: string,
  issueId: number,
  action: IssueAction,
  now = Date.now(),
) {
  const expires = now + WEEK
  const signature = hex(await crypto.subtle.sign('HMAC', await key(secret), message(issueId, action, expires)))
  return `${origin}/api/actions/${issueId}/${action}?expires=${expires}&signature=${signature}`
}

export async function verifyAction(
  secret: string,
  issueId: number,
  action: IssueAction,
  expires: number,
  signature: string,
  now = Date.now(),
) {
  if (!Number.isFinite(expires) || expires < now || !/^[0-9a-f]{64}$/.test(signature)) return false
  const bytes = new Uint8Array(signature.match(/../g)!.map((h) => parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', await key(secret), bytes, message(issueId, action, expires))
}
