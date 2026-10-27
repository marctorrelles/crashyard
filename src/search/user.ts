// Server only (node:crypto, through nodejs_compat): the browser imports query.ts, so the filters take this as a parameter
import { createHash } from 'node:crypto'

/** A user as crashyard keeps one: the first 32 hex of the SHA-256 of their id (else email, else username). Ingest
 *  hashes with it and `user:` searches hash the typed value with it, so the two always agree */
export const hashUser = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 32)
