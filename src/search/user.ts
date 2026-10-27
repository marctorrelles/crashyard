// Server only (node:crypto, through nodejs_compat): the browser imports query.ts, so the filters take `userMatch` as a
// parameter
import { createHash } from 'node:crypto'

/** A user as crashyard keeps one: the first 32 hex of the SHA-256 of their id (else email, else username). Ingest
 *  hashes with it and `user:` searches hash the typed value with it, so the two always agree */
export const hashUser = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)

/** The user fields kept, each only as a hash. Not the IP address: crashyard keeps none, and an IPv4 hash is undone by
 *  trying all 4 billion */
export const USER_FIELDS = ['id', 'email', 'username', 'name'] as const
type UserField = (typeof USER_FIELDS)[number]

// An email matches whatever its case; the rest as sent
const fieldHash = (field: UserField, value: string) =>
  hashUser(`${field}:${field === 'email' ? value.trim().toLowerCase() : value}`)

/** `events.user_keys`: a hash per field the SDK sent, space-separated; undefined without any */
export function userKeysOf(user: Record<string, unknown>): string | undefined {
  const hashes = USER_FIELDS.flatMap((f) => {
    const v = user[f]
    const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
    return text ? [fieldHash(f, text)] : []
  })
  return hashes.length ? hashes.join(' ') : undefined
}

/** What a search's `user:` (any field) or `user.<field>:` value matches: the hash events before 0021 kept
 *  (`user_hash`, and `issue_users`) and the field hashes in `user_keys` */
export function userMatch(key: string, value: string): { legacy: string; keys: string[] } {
  const fields = key === 'user' ? USER_FIELDS : USER_FIELDS.filter((f) => key === `user.${f}`)
  return { legacy: hashUser(value), keys: fields.map((f) => fieldHash(f, value)) }
}
