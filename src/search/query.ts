// Sentry's search syntax, turned into SQL over issues: `key:value` tokens and free text.
// `is:unresolved level:error release:1.0.1 device:iPad* "audio engine" !os:Android times:>10 lastSeen:-24h has:user`

/** How long an issue reads as new, as Sentry's */
export const NEW_FOR = 7 * 864e5

/** A `key:[a,b]` token keeps its list in `values` (any of them; `!` none of them), and `value` as their text */
export type Token = {
  key?: string
  op: ':' | '>' | '<' | '>=' | '<='
  value: string
  values?: string[]
  negate: boolean
}

const TOKEN = /(!)?(?:([\w.-]+):(>=|<=|>|<)?)?(?:"((?:[^"\\]|\\.)*)"|\[((?:[^\]"\\]|"(?:[^"\\]|\\.)*"|\\.)*)\]|(\S+))/g

const unescape = (s: string) => s.replace(/\\(.)/g, '$1')

/** The inside of `[a,"b c",d]`, split on the commas outside quotes; empty items kept, so they line up with the commas */
export function listItems(inside: string): string[] {
  const values: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i]
    if (c === '\\' && i + 1 < inside.length) current += inside[++i]
    else if (c === '"') quoted = !quoted
    else if (c === ',' && !quoted) {
      values.push(current.trim())
      current = ''
    } else current += c
  }
  values.push(current.trim())
  return values
}

/** Every token with where it sits in the query (`end` exclusive), empty ones too: for suggestions at the caret */
export function scan(query: string): { token: Token; start: number; end: number }[] {
  return [...query.matchAll(TOKEN)].map((m) => {
    const start = m.index
    const end = start + m[0].length
    const at = { op: (m[3] as Token['op']) ?? ':', negate: !!m[1] }
    // A list needs a key; a bare `[a,b]` is a word
    if (m[5] !== undefined && m[2] === undefined)
      return { token: { ...at, value: m[0].slice(m[1] ? 1 : 0) }, start, end }
    if (m[5] !== undefined) {
      const values = listItems(m[5]).filter((v) => v !== '')
      return { token: { key: m[2], ...at, value: values.join(','), values }, start, end }
    }
    return { token: { key: m[2], ...at, value: m[4] !== undefined ? unescape(m[4]) : m[6] }, start, end }
  })
}

/** Splits a query into tokens: `key:value`, `!key:value`, `key:>value`, `key:[a,b]`, `"quoted text"`, words */
export const tokenize = (query: string): Token[] =>
  scan(query)
    .map((s) => s.token)
    .filter((t) => t.value !== '')

/** A value as the grammar reads it back: quoted when it has a space, a quote, `,` `[` `]` `:`, or starts as an operator */
export const quote = (value: string) =>
  /[\s",[\]:]|^[!<>]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value

/** The query back as text, for a token changed or removed (the status tabs rewrite `is:`) */
export const unparse = (tokens: Token[]) =>
  tokens
    .map(
      (t) =>
        `${t.negate ? '!' : ''}${t.key ? `${t.key}:${t.op === ':' ? '' : t.op}` : ''}${
          t.key && t.values ? `[${t.values.map(quote).join(',')}]` : quote(t.value)
        }`,
    )
    .join(' ')

/** A query with its `key` tokens replaced by `key:value` (or removed, without a value) */
export function withToken(query: string, key: string, value?: string): string {
  const rest = tokenize(query).filter((t) => t.key !== key)
  return unparse(value ? [{ key, op: ':', value, negate: false }, ...rest] : rest)
}

/** The query with its token at `index` replaced (a pill's operator or values changed); past the end, added */
export function setToken(query: string, index: number, token: Token): string {
  const tokens = tokenize(query)
  if (index < tokens.length) tokens[index] = token
  else tokens.push(token)
  return unparse(tokens)
}

/** The query without its token at `index` (a pill's ×) */
export const removeToken = (query: string, index: number) => unparse(tokenize(query).filter((_, i) => i !== index))

// A token of one value reads `key:a`; of more, `key:[a,b]`; of none, it goes
const withValues = (t: Token, values: string[]): Token | undefined =>
  values.length === 0
    ? undefined
    : values.length === 1
      ? { key: t.key, op: t.op, value: values[0], negate: t.negate }
      : { key: t.key, op: t.op, value: values.join(','), values, negate: t.negate }

const valuesOf = (t: Token) => t.values ?? [t.value]

/**
 * Include (`negate` false) or exclude a value of a key, as a facet click does. Including adds it to the key's
 * `key:[…]` (or adds `key:value`); excluding adds it to `!key:[…]`; either takes it out of the other list.
 */
export function addValue(query: string, key: string, value: string, negate: boolean): string {
  const tokens = tokenize(query)
  const same = (t: Token, n: boolean) => t.key === key && t.op === ':' && t.negate === n
  const into = tokens.findIndex((t) => same(t, negate))
  const out: (Token | undefined)[] = tokens.map((t, i) => {
    if (i === into) return valuesOf(t).includes(value) ? t : withValues(t, [...valuesOf(t), value])
    if (same(t, !negate))
      return withValues(
        t,
        valuesOf(t).filter((v) => v !== value),
      )
    return t
  })
  if (into === -1) out.push({ key, op: ':', value, negate })
  return unparse(out.filter((t) => t !== undefined))
}

/** What a key is, for the search bar: how it reads, which operators it takes, the values it can have */
export type KeyInfo = {
  key: string
  description: string
  kind: 'enum' | 'text' | 'number' | 'time' | 'tag'
  values?: string[]
}

const WITHIN = ['-1h', '-24h', '-7d', '-30d']

export const ISSUE_KEYS: KeyInfo[] = [
  {
    key: 'is',
    description: 'Status',
    kind: 'enum',
    values: ['unresolved', 'resolved', 'ignored', 'new', 'regressed', 'ongoing'],
  },
  { key: 'level', description: 'Level', kind: 'enum', values: ['fatal', 'error', 'warning', 'info', 'debug'] },
  { key: 'type', description: 'Error, message, csp…', kind: 'text' },
  { key: 'platform', description: 'The SDK’s platform', kind: 'text' },
  { key: 'firstRelease', description: 'Release it first happened in', kind: 'text' },
  { key: 'lastRelease', description: 'Release it last happened in', kind: 'text' },
  { key: 'project', description: 'Project', kind: 'text' },
  { key: 'has', description: 'Has a tag', kind: 'enum' },
  { key: 'times', description: 'Events', kind: 'number' },
  { key: 'users', description: 'Users affected', kind: 'number' },
  { key: 'lastSeen', description: 'Last event (-24h: within a day)', kind: 'time', values: WITHIN },
  { key: 'firstSeen', description: 'First event (-24h: within a day)', kind: 'time', values: WITHIN },
  { key: 'trace', description: 'Had an event in a trace', kind: 'text' },
]

export const LOG_KEYS: KeyInfo[] = [
  { key: 'level', description: 'Level', kind: 'enum', values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] },
  { key: 'release', description: 'Release', kind: 'text' },
  { key: 'environment', description: 'Environment', kind: 'text' },
  { key: 'message', description: 'Words in the message', kind: 'text' },
  { key: 'trace', description: 'Trace id', kind: 'text' },
  { key: 'timestamp', description: 'Logged (-1h: within an hour)', kind: 'time', values: WITHIN },
  { key: 'has', description: 'Has an attribute', kind: 'enum' },
  { key: 'project', description: 'Project', kind: 'text' },
]

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

// One value as `match`; a list as `IN (?,…)`, or an `OR` of matches when one has a `*`
function matchAny(column: string, values: string[]): [string, unknown[]] {
  if (values.length === 1) {
    const [sql, value] = match(column, values[0])
    return [sql, [value]]
  }
  if (!values.some((v) => v.includes('*'))) return [`${column} IN (${values.map(() => '?').join(',')})`, values]
  return [`(${values.map((v) => match(column, v)[0]).join(' OR ')})`, values]
}

// Conditions that are any of several: one as it is, more in brackets joined by OR
const anyOf = (parts: [string, unknown[]][]): [string, unknown[]] =>
  parts.length === 1
    ? parts[0]
    : [`(${parts.map(([sql]) => `(${sql})`).join(' OR ')})`, parts.flatMap(([, params]) => params)]

// FTS5 for words, every one as a prefix: `"slow"* "export"*`
const ftsWords = (words: string[]) => words.map((w) => `"${w}"*`).join(' ')
const wordsOf = (value: string) => value.match(/[\p{L}\p{N}_]+/gu) ?? []

function status(value: string, now: number): [string, unknown[]] | undefined {
  if (STATUSES.has(value)) return ['i.status = ?', [value]]
  if (value === 'new') return ["i.status = 'unresolved' AND i.substatus = 'new' AND i.first_seen >= ?", [now - NEW_FOR]]
  if (value === 'ongoing')
    return [
      "i.status = 'unresolved' AND (i.substatus = 'ongoing' OR (i.substatus = 'new' AND i.first_seen < ?))",
      [now - NEW_FOR],
    ]
  if (value === 'regressed') return ["i.status = 'unresolved' AND i.substatus = 'regressed'", []]
}

// As Sentry: `lastSeen:-24h` is within the last day, `lastSeen:+24h` longer ago; `<-24h` reads "less than a day ago"
function timeOp(t: Token) {
  if (t.op === ':') return t.value.startsWith('+') ? '<' : '>='
  return t.value.startsWith('-') ? { '>': '<', '<': '>', '>=': '<=', '<=': '>=' }[t.op] : SQL_OP[t.op]
}

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
      const words = wordsOf(t.value)
      if (t.negate && words.length)
        add('i.id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)', true, ftsWords(words))
      else text.push(...words)
      continue
    }
    const key = t.key
    const values = valuesOf(t)
    if (key === 'is') {
      const parts = values.map((v) => status(v, now)).filter((p) => p !== undefined)
      if (parts.length) {
        const [sql, values] = anyOf(parts)
        add(sql, t.negate, ...values)
      }
      continue
    }
    if (key === 'project') {
      if (!t.negate) projectSlugs.push(...values)
      else {
        const [sql, slugs] = matchAny('slug', values)
        add(`i.project_id NOT IN (SELECT id FROM projects WHERE ${sql})`, false, ...slugs)
      }
      continue
    }
    if (key === 'has') {
      const [sql, keys] = matchAny('v.key', values)
      add(`EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND ${sql})`, t.negate, ...keys)
      continue
    }
    if (NUMBERS[key]) {
      const n = Number(t.value)
      if (!t.values && Number.isFinite(n)) add(`${NUMBERS[key]} ${SQL_OP[t.op]} ?`, t.negate, n)
      continue
    }
    if (TIMES[key]) {
      const at = t.values ? undefined : timeOf(t.value, now)
      if (at !== undefined) add(`${TIMES[key]} ${timeOp(t)} ?`, t.negate, at)
      continue
    }
    if (key === 'trace') {
      const [sql, ids] = matchAny('e.trace_id', values)
      add(`EXISTS (SELECT 1 FROM events e WHERE e.issue_id = i.id AND ${sql})`, t.negate, ...ids)
      continue
    }
    if (COLUMNS[key]) {
      const [sql, matched] = matchAny(COLUMNS[key], values)
      add(sql, t.negate, ...matched)
      continue
    }
    const [sql, matched] = matchAny('v.value', values)
    add(
      `EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = ? AND ${sql})`,
      t.negate,
      key,
      ...matched,
    )
  }
  if (text.length) add('i.id IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)', false, ftsWords(text))
  return { where, params, projectSlugs }
}

const LOG_COLUMNS: Record<string, string> = {
  level: 'l.level',
  release: 'l.release',
  environment: 'l.environment',
  trace: 'l.trace_id',
}
const LOG_LEVEL_ALIASES: Record<string, string> = { warning: 'warn', critical: 'fatal' }

/** SQL conditions over `logs l`. Unknown keys are the app's attributes (log_attributes) */
export function logFilter(query: string, now: number): Filter {
  const where: string[] = []
  const params: unknown[] = []
  const projectSlugs: string[] = []
  const text: string[] = []
  const add = (sql: string, negate: boolean, ...values: unknown[]) => {
    where.push(negate ? `NOT (${sql})` : sql)
    params.push(...values)
  }
  for (const t of tokenize(query)) {
    if (!t.key || t.key === 'message' || t.key === 'body') {
      if (t.values) {
        // `message:[a,b]`: the words of any of them
        const groups = t.values.map(wordsOf).filter((w) => w.length)
        if (groups.length)
          add(
            'l.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)',
            t.negate,
            groups.map((w) => `(${ftsWords(w)})`).join(' OR '),
          )
        continue
      }
      const words = wordsOf(t.value)
      if (!words.length) continue
      if (t.negate) add('l.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)', true, ftsWords(words))
      else text.push(...words)
      continue
    }
    const key = t.key
    const values = valuesOf(t)
    if (key === 'project') {
      if (!t.negate) projectSlugs.push(...values)
      else {
        const [sql, slugs] = matchAny('slug', values)
        add(`l.project_id NOT IN (SELECT id FROM projects WHERE ${sql})`, false, ...slugs)
      }
      continue
    }
    if (key === 'timestamp') {
      const at = t.values ? undefined : timeOf(t.value, now)
      if (at !== undefined) add(`l.timestamp ${timeOp(t)} ?`, t.negate, at)
      continue
    }
    if (key === 'has') {
      const [sql, keys] = matchAny('a.key', values)
      add(`EXISTS (SELECT 1 FROM log_attributes a WHERE a.log_id = l.id AND ${sql})`, t.negate, ...keys)
      continue
    }
    if (LOG_COLUMNS[key]) {
      const [sql, matched] = matchAny(
        LOG_COLUMNS[key],
        key === 'level' ? values.map((v) => LOG_LEVEL_ALIASES[v] ?? v) : values,
      )
      add(sql, t.negate, ...matched)
      continue
    }
    const [sql, matched] = matchAny('a.value', values)
    add(
      `EXISTS (SELECT 1 FROM log_attributes a WHERE a.log_id = l.id AND a.key = ? AND ${sql})`,
      t.negate,
      key,
      ...matched,
    )
  }
  if (text.length) add('l.id IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?)', false, ftsWords(text))
  return { where, params, projectSlugs }
}
