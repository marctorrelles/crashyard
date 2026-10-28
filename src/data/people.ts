// People, for crashyard's own sign-in (src/auth/AGENTS.md): users and their roles, sessions, passkeys, invites,
// recovery codes and tokens for agents. Every secret is stored as its SHA-256 and compared by it.

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type Role = (typeof ROLES)[number]
export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}
/** What each role can do, in the words People shows */
export const ROLE_HINTS: Record<Role, string> = {
  owner: 'Everything, people and sign-in included',
  admin: 'Settings, projects, notifications and tokens',
  member: 'Resolve, ignore, assign and note issues, and edit dashboards',
  viewer: 'Read everything, change nothing',
}
/** Whether a role reaches another: owner reaches all, viewer only viewer */
export const reaches = (role: Role, needed: Role) => ROLES.indexOf(role) <= ROLES.indexOf(needed)
export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role)

export type User = {
  id: number
  email: string
  name: string
  role: Role
  github_id: number | null
  created_at: number
  created_by: string | null
  last_seen_at: number | null
}

export const SESSION_DAYS = 90
const DAY = 864e5
/** A session is renewed when under this much is left, at most once a day, so reading pages rarely writes */
const RENEW_UNDER = 60 * DAY

export const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

/** A secret for a link, cookie or token: `bytes` random bytes as base64url */
export function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Readable codes, groups of five letters and digits with no 0, O, 1, I or L: a setup code and recovery codes
const READABLE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export function readableCode(groups: number) {
  // Bytes from 248 up are dropped: 256 isn't a multiple of 31, and taking them would make 8 letters likelier
  const chars: string[] = []
  while (chars.length < groups * 5)
    for (const b of crypto.getRandomValues(new Uint8Array(groups * 5)))
      if (b < 248 && chars.length < groups * 5) chars.push(READABLE[b % READABLE.length])
  return Array.from({ length: groups }, (_, i) => chars.slice(i * 5, i * 5 + 5).join('')).join('-')
}
/** A typed code as stored: capitals, no spaces or dashes */
export const normalCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

export const userCount = async (db: D1Database) =>
  ((await db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0) as number

export const userById = (db: D1Database, id: number) =>
  db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>()
export const userByEmail = (db: D1Database, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first<User>()

export async function createUser(
  db: D1Database,
  u: { email: string; name: string; role: Role; createdBy: string | null; githubId?: number },
  now: number,
) {
  const row = await db
    .prepare(
      'INSERT INTO users (email, name, role, github_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
    )
    .bind(u.email.trim().toLowerCase(), u.name.trim(), u.role, u.githubId ?? null, now, u.createdBy)
    .first<User>()
  return row!
}

export const listUsers = async (db: D1Database) =>
  (
    await db
      .prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys FROM users u
         ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.name`,
      )
      .all<User & { passkeys: number }>()
  ).results

// Checked in the statement that changes it, so two owners demoting each other at once can't both pass
const KEEPS_AN_OWNER = "(role != 'owner' OR (SELECT COUNT(*) FROM users WHERE role = 'owner') > 1)"
const NO_OWNER = 'crashyard needs an owner. Make someone else an owner first.'

/** A new role, refused when it would leave no owner */
export async function changeRole(db: D1Database, id: number, role: Role) {
  const user = await userById(db, id)
  if (!user) throw new Error('That person isn’t here anymore.')
  const changed = await db
    .prepare(`UPDATE users SET role = ?1 WHERE id = ?2 AND (?1 = 'owner' OR ${KEEPS_AN_OWNER})`)
    .bind(role, id)
    .run()
  if (!changed.meta.changes) throw new Error(NO_OWNER)
}

/** Removing someone ends their sessions and tokens at once (cascade); their name stays on what they did */
export async function removeUser(db: D1Database, id: number) {
  const user = await userById(db, id)
  if (!user) return
  const removed = await db.prepare(`DELETE FROM users WHERE id = ? AND ${KEEPS_AN_OWNER}`).bind(id).run()
  if (!removed.meta.changes) throw new Error(NO_OWNER)
}

// Sessions

/** A new session: the cookie's value, and when it ends */
export async function startSession(db: D1Database, userId: number, userAgent: string | null, now: number) {
  const token = randomToken()
  const expires = now + SESSION_DAYS * DAY
  await db.batch([
    db
      .prepare(
        'INSERT INTO sessions (hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(await sha256(token), userId, now, now, expires, userAgent?.slice(0, 200) ?? null),
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, userId),
  ])
  return { token, expires }
}

/** Who a session cookie is, and whether to send the cookie again (renewed); null when it's unknown or over */
export async function sessionUser(db: D1Database, token: string, now: number) {
  const hash = await sha256(token)
  const row = await db
    .prepare(
      `SELECT u.*, s.expires_at AS session_expires, s.last_seen_at AS session_seen FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires_at > ?`,
    )
    .bind(hash, now)
    .first<User & { session_expires: number; session_seen: number }>()
  if (!row) return null
  const { session_expires, session_seen, ...user } = row
  let renewed: number | null = null
  if (session_expires - now < RENEW_UNDER && now - session_seen > DAY) {
    renewed = now + SESSION_DAYS * DAY
    await db.batch([
      db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE hash = ?').bind(renewed, now, hash),
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, user.id),
    ])
  } else if (now - session_seen > DAY) {
    await db.batch([
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE hash = ?').bind(now, hash),
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, user.id),
    ])
  }
  return { user: user as User, hash, renewed }
}

export const endSession = async (db: D1Database, token: string) =>
  db
    .prepare('DELETE FROM sessions WHERE hash = ?')
    .bind(await sha256(token))
    .run()

export const sessionsOf = async (db: D1Database, userId: number, now: number) =>
  (
    await db
      .prepare(
        'SELECT hash, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
      )
      .bind(userId, now)
      .all<{ hash: string; created_at: number; last_seen_at: number; user_agent: string | null }>()
  ).results

/** Ends one of a person's sessions by its hash, or all but `keep` */
export const endSessionOf = (db: D1Database, userId: number, hash: string) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND hash = ?').bind(userId, hash).run()
export const endOtherSessions = (db: D1Database, userId: number, keep: string) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND hash != ?').bind(userId, keep).run()

/** The hourly cron: sessions and challenges past their end */
export async function pruneSignIn(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM challenges WHERE expires_at <= ?').bind(now),
  ])
}

// Passkeys

export type Passkey = {
  id: string
  user_id: number
  public_key: ArrayBuffer | Uint8Array
  counter: number
  transports: string | null
  name: string
  created_at: number
  last_used_at: number | null
}

export const passkeyById = (db: D1Database, id: string) =>
  db.prepare('SELECT * FROM passkeys WHERE id = ?').bind(id).first<Passkey>()
export const passkeysOf = async (db: D1Database, userId: number) =>
  (
    await db
      .prepare(
        'SELECT id, name, transports, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at',
      )
      .bind(userId)
      .all<Omit<Passkey, 'public_key' | 'counter' | 'user_id'>>()
  ).results

export const addPasskey = (
  db: D1Database,
  p: { id: string; userId: number; publicKey: Uint8Array; counter: number; transports?: string[]; name: string },
  now: number,
) =>
  db
    .prepare(
      'INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(p.id, p.userId, p.publicKey, p.counter, p.transports ? JSON.stringify(p.transports) : null, p.name, now)

export const usedPasskey = (db: D1Database, id: string, counter: number, now: number) =>
  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').bind(counter, now, id).run()

export const renamePasskey = (db: D1Database, userId: number, id: string, name: string) =>
  db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').bind(name, id, userId).run()

/** Removing a passkey keeps at least one way in: another passkey, an unused recovery code or GitHub */
export async function removePasskey(db: D1Database, userId: number, id: string) {
  const left = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM passkeys WHERE user_id = ?1 AND id != ?2) AS passkeys,
         (SELECT COUNT(*) FROM recovery_codes WHERE user_id = ?1 AND used_at IS NULL) AS codes,
         (SELECT github_id FROM users WHERE id = ?1) AS github`,
    )
    .bind(userId, id)
    .first<{ passkeys: number; codes: number; github: number | null }>()
  if (left && !left.passkeys && !left.codes && !left.github)
    throw new Error('That’s your only way to sign in. Add another passkey or make recovery codes first.')
  await db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(id, userId).run()
}

/** A passkey's name from the browser that made it */
export function deviceName(userAgent: string | null) {
  const ua = userAgent ?? ''
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Passkey'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : ''
  return browser && device !== 'Passkey' ? `${device}, ${browser}` : device
}

// Challenges

export type Purpose = 'setup' | 'signin' | 'register' | 'invite' | 'github' | 'github-app'

/** A challenge, five minutes unless `ttl` says otherwise (creating the GitHub App takes longer) */
export async function saveChallenge(
  db: D1Database,
  challenge: string,
  purpose: Purpose,
  data: unknown,
  now: number,
  ttl = 5 * 60_000,
) {
  const id = randomToken(16)
  await db
    .prepare('INSERT INTO challenges (id, challenge, purpose, data, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, challenge, purpose, JSON.stringify(data), now + ttl)
    .run()
  return id
}

/** A challenge, taken: it can't be used twice, and an old one is gone */
export async function takeChallenge<T>(db: D1Database, id: string, purpose: Purpose, now: number) {
  const row = await db
    .prepare('DELETE FROM challenges WHERE id = ? AND purpose = ? RETURNING challenge, data, expires_at')
    .bind(id, purpose)
    .first<{ challenge: string; data: string; expires_at: number }>()
  if (!row || row.expires_at <= now) return null
  return { challenge: row.challenge, data: JSON.parse(row.data) as T }
}

// Invites

export const INVITE_DAYS = 7

export async function createInvite(db: D1Database, role: Role, email: string | null, by: string, now: number) {
  const token = randomToken(24)
  await db
    .prepare('INSERT INTO invites (hash, role, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), role, email?.trim().toLowerCase() || null, by, now, now + INVITE_DAYS * DAY)
    .run()
  return token
}

export type Invite = {
  hash: string
  role: Role
  email: string | null
  created_by: string
  created_at: number
  expires_at: number
  used_at: number | null
}

/** An invite by its link's token, with whether it can still be used */
export async function inviteOf(db: D1Database, token: string, now: number) {
  const invite = await db
    .prepare('SELECT * FROM invites WHERE hash = ?')
    .bind(await sha256(token))
    .first<Invite>()
  if (!invite) return null
  const inviter = await userByEmail(db, invite.created_by)
  return {
    ...invite,
    inviter: inviter?.name ?? invite.created_by,
    usable: invite.used_at === null && invite.expires_at > now,
  }
}

export const listInvites = async (db: D1Database, now: number) =>
  (
    await db
      .prepare('SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC')
      .bind(now)
      .all<Invite>()
  ).results

export const revokeInvite = (db: D1Database, hash: string) =>
  db.prepare('DELETE FROM invites WHERE hash = ? AND used_at IS NULL').bind(hash).run()

/** Marks an invite used, only if it still could be: one use, even with two tabs */
export const useInvite = (db: D1Database, hash: string, userId: number | null, now: number) =>
  db
    .prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(now, userId, hash, now)

/** An invite taken by someone who then couldn't join, usable again */
export const unuseInvite = (db: D1Database, hash: string) =>
  db.prepare('UPDATE invites SET used_at = NULL, used_by = NULL WHERE hash = ?').bind(hash).run()

// Recovery codes

export const RECOVERY_CODES = 10

/** Ten new recovery codes for a person, replacing any they had; shown once */
export async function newRecoveryCodes(db: D1Database, userId: number) {
  const codes = Array.from({ length: RECOVERY_CODES }, () => readableCode(2))
  await db.batch([
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').bind(userId),
    ...(await Promise.all(
      codes.map(async (c) =>
        db
          .prepare('INSERT INTO recovery_codes (user_id, hash) VALUES (?, ?)')
          .bind(userId, await sha256(normalCode(c))),
      ),
    )),
  ])
  return codes
}

export const recoveryCodesLeft = async (db: D1Database, userId: number) =>
  ((
    await db
      .prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .bind(userId)
      .first<{ n: number }>()
  )?.n ?? 0) as number

/** Signs in with a recovery code: the person, once per code */
export async function useRecoveryCode(db: D1Database, email: string, code: string, now: number) {
  const user = await userByEmail(db, email)
  if (!user) return null
  const used = await db
    .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND hash = ? AND used_at IS NULL RETURNING hash')
    .bind(now, user.id, await sha256(normalCode(code)))
    .first()
  return used ? user : null
}

// Tokens for agents

export type UserToken = {
  id: number
  user_id: number
  name: string
  scope: 'read' | 'change'
  created_at: number
  last_used_at: number | null
  expires_at: number | null
}

export async function createUserToken(
  db: D1Database,
  userId: number,
  name: string,
  scope: 'read' | 'change',
  expiresAt: number | null,
  now: number,
) {
  const token = `cyp_${randomToken(24)}`
  await db
    .prepare('INSERT INTO user_tokens (user_id, name, hash, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, name, await sha256(token), scope, now, expiresAt)
    .run()
  return token
}

export const userTokensOf = async (db: D1Database, userId: number) =>
  (
    await db
      .prepare(
        'SELECT id, user_id, name, scope, created_at, last_used_at, expires_at FROM user_tokens WHERE user_id = ? ORDER BY created_at DESC',
      )
      .bind(userId)
      .all<UserToken>()
  ).results

export const revokeUserToken = (db: D1Database, userId: number, id: number) =>
  db.prepare('DELETE FROM user_tokens WHERE id = ? AND user_id = ?').bind(id, userId).run()

/** Who a `cyp_` token acts for, and its scope; marks it used at most once a minute */
export async function userTokenOf(db: D1Database, token: string, now: number) {
  const row = await db
    .prepare(
      `SELECT t.id AS token_id, t.name AS token_name, t.scope, t.last_used_at AS token_used, u.* FROM user_tokens t
       JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    )
    .bind(await sha256(token), now)
    .first<User & { token_id: number; token_name: string; scope: 'read' | 'change'; token_used: number | null }>()
  if (!row) return null
  if (!row.token_used || now - row.token_used > 60_000)
    await db.prepare('UPDATE user_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.token_id).run()
  const { token_id, token_name, scope, token_used: _, ...user } = row
  return { user: user as User, tokenId: token_id, name: token_name, scope }
}

/** What a token may do: a read token reads, a change token triages, never more than its person's role */
export const tokenRole = (role: Role, scope: 'read' | 'change'): Role =>
  scope === 'read' ? 'viewer' : reaches(role, 'member') ? 'member' : role

export const linkGitHub = (db: D1Database, userId: number, githubId: number) =>
  db.prepare('UPDATE users SET github_id = ? WHERE id = ?').bind(githubId, userId).run()
export const userByGitHub = (db: D1Database, githubId: number) =>
  db.prepare('SELECT * FROM users WHERE github_id = ?').bind(githubId).first<User>()
