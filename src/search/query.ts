// Sentry's search syntax, turned into SQL over issues: `key:value` tokens and free text.
// `is:unresolved level:error release:1.0.1 device:iPad* "audio engine" !os:Android times:>10 lastSeen:-24h has:user`

/** How long an issue reads as new, as Sentry's */
export const NEW_FOR = 7 * 864e5

export type Token = { key?: string; op: ':' | '>' | '<' | '>=' | '<='; value: string; negate: boolean }

/** Splits a query into tokens: `key:value`, `!key:value`, `key:>value`, `"quoted text"`, words */
export function tokenize(query: string): Token[] {
  const tokens: Token[] = []
  const re = /(!)?(?:([\w.-]+):(>=|<=|>|<)?)?(?:"((?:[^"\\]|\\.)*)"|(\S+))/g
  for (const m of query.matchAll(re)) {
    const value = m[4] !== undefined ? m[4].replace(/\\(.)/g, '$1') : m[5]
    if (value === undefined || value === '') continue
    tokens.push({ key: m[2], op: (m[3] as Token['op']) ?? ':', value, negate: !!m[1] })
  }
  return tokens
}

const quote = (t: Token) => (/[\s"]/.test(t.value) ? `"${t.value.replace(/(["\\])/g, '\\$1')}"` : t.value)

/** The query back as text, for a token changed or removed (the status tabs rewrite `is:`) */
export const unparse = (tokens: Token[]) =>
  tokens.map((t) => `${t.negate ? '!' : ''}${t.key ? `${t.key}:${t.op === ':' ? '' : t.op}` : ''}${quote(t)}`).join(' ')

/** A query with its `key` tokens replaced by `key:value` (or removed, without a value) */
export function withToken(query: string, key: string, value?: string): string {
  const rest = tokenize(query).filter((t) => t.key !== key)
  return unparse(value ? [{ key, op: ':', value, negate: false }, ...rest] : rest)
}

const DURATION = /^[-+](\d+)([smhdw])$/
const UNIT = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }

/** `-24h` or `+24h` (that long ago) or a date; in ms */
export function timeOf(value: string, now: number): number | undefined {
  const d = value.match(DURATION)
  if (d) return now - Number(d[1]) * UNIT[d[2] as keyof typeof UNIT]
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : t
}

const COLUMNS: Record<string, string> = {
  level: 'i.level',
  type: 'i.type',
  platform: 'i.platform',
  firstRelease: 'i.first_release',
  lastRelease: 'i.last_release',
  'issue.id': 'i.id',
}
const NUMBERS: Record<string, string> = { times: 'i.count', events: 'i.count', users: 'i.user_count' }
const TIMES: Record<string, string> = { lastSeen: 'i.last_seen', firstSeen: 'i.first_seen' }
const STATUSES = new Set(['unresolved', 'resolved', 'ignored'])
const SQL_OP = { ':': '=', '>': '>', '<': '<', '>=': '>=', '<=': '<=' }

// `iPad*` matches as a prefix, `*Error` as a suffix: SQLite's GLOB, which is case-sensitive as Sentry's matching is
const match = (column: string, value: string): [string, unknown] =>
  value.includes('*') ? [`${column} GLOB ?`, value] : [`${column} = ?`, value]

export type Filter = { where: string[]; params: unknown[]; projectSlugs: string[] }

/** SQL conditions over `issues i` for a query. Unknown keys are tags (issue_tag_values): "had an event with it" */
export function issueFilter(query: string, now: number): Filter {
  const where: string[] = []
  const params: unknown[] = []
  const projectSlugs: string[] = []
  const text: string[] = []
  const add = (sql: string, negate: boolean, ...values: unknown[]) => {
    where.push(negate ? `NOT (${sql})` : sql)
    params.push(...values)
  }
  for (const t of tokenize(query)) {
    if (!t.key) {
      // Free text: every word, as a prefix, in the title or culprit
      const words = t.value.match(/[\p{L}\p{N}_]+/gu) ?? []
      if (t.negate && words.length) {
        add(
          'i.id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)',
          true,
          words.map((w) => `"${w}"*`).join(' '),
        )
      } else text.push(...words)
      continue
    }
    const key = t.key
    if (key === 'is') {
      if (STATUSES.has(t.value)) add('i.status = ?', t.negate, t.value)
      else if (t.value === 'new')
        add("i.status = 'unresolved' AND i.substatus = 'new' AND i.first_seen >= ?", t.negate, now - NEW_FOR)
      else if (t.value === 'ongoing')
        add(
          "i.status = 'unresolved' AND (i.substatus = 'ongoing' OR (i.substatus = 'new' AND i.first_seen < ?))",
          t.negate,
          now - NEW_FOR,
        )
      else if (t.value === 'regressed') add("i.status = 'unresolved' AND i.substatus = 'regressed'", t.negate)
      continue
    }
    if (key === 'project') {
      if (!t.negate) projectSlugs.push(t.value)
      else add('i.project_id NOT IN (SELECT id FROM projects WHERE slug = ?)', false, t.value)
      continue
    }
    if (key === 'has') {
      add('EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ?)', t.negate, t.value)
      continue
    }
    if (NUMBERS[key]) {
      const n = Number(t.value)
      if (Number.isFinite(n)) add(`${NUMBERS[key]} ${SQL_OP[t.op]} ?`, t.negate, n)
      continue
    }
    if (TIMES[key]) {
      const at = timeOf(t.value, now)
      if (at === undefined) continue
      // As Sentry: `lastSeen:-24h` is within the last day, `lastSeen:+24h` longer ago; `<-24h` reads "less than a day ago"
      const op =
        t.op === ':'
          ? t.value.startsWith('+')
            ? '<'
            : '>='
          : t.value.startsWith('-')
            ? { '>': '<', '<': '>', '>=': '<=', '<=': '>=' }[t.op]
            : SQL_OP[t.op]
      add(`${TIMES[key]} ${op} ?`, t.negate, at)
      continue
    }
    if (COLUMNS[key]) {
      const [sql, value] = match(COLUMNS[key], t.value)
      add(sql, t.negate, value)
      continue
    }
    const [sql, value] = match('v.value', t.value)
    add(
      `EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ? AND ${sql})`,
      t.negate,
      key,
      value,
    )
  }
  if (text.length)
    add('i.id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)', false, text.map((w) => `"${w}"*`).join(' '))
  return { where, params, projectSlugs }
}
