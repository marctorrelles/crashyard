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

/**
 * The inside of `[a,"b c",d]`, split on the commas outside quotes; empty items kept, so they line up with the commas.
 * Spaces around an item go, but not those inside its quotes (or escaped)
 */
export function listItems(inside: string): string[] {
  const values: string[] = []
  // Each item's characters, and whether each was quoted or escaped (kept as it is) or plain (trimmed at the ends)
  let current: { c: string; kept: boolean }[] = []
  const done = () => {
    let from = 0
    let to = current.length
    while (from < to && !current[from].kept && /\s/.test(current[from].c)) from++
    while (to > from && !current[to - 1].kept && /\s/.test(current[to - 1].c)) to--
    values.push(
      current
        .slice(from, to)
        .map((x) => x.c)
        .join(''),
    )
    current = []
  }
  let quoted = false
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i]
    if (c === '\\' && i + 1 < inside.length) current.push({ c: inside[++i], kept: true })
    else if (c === '"') quoted = !quoted
    else if (c === ',' && !quoted) done()
    else current.push({ c, kept: quoted })
  }
  done()
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

/**
 * A value as the grammar reads it back: quoted when it has a space, a quote, a backslash, `,` `[` `]` `:`, or starts
 * as an operator (`!` `<` `>` `=`: after `key:>`, `=5` would read as `>=`)
 */
export const quote = (value: string) =>
  /[\s",[\]:\\]|^[!<>=]/.test(value) ? `"${value.replace(/(["\\])/g, '\\$1')}"` : value

/** A key the grammar can write as `key:value` (and so a value of it can be shown only or excluded) */
export const isSearchableKey = (key: string) => /^[\w.-]+$/.test(key)

// Logs' keys that are columns or mean something else in the search: an attribute by one of these names isn't its own
const LOG_RESERVED = new Set([
  'level',
  'release',
  'environment',
  'trace',
  'timestamp',
  'has',
  'message',
  'body',
  'project',
])

// The SDK's own attributes that are columns too; the other `sentry.*` ones aren't stored as attributes to search
const SENTRY_COLUMNS: Record<string, string> = { 'sentry.release': 'release', 'sentry.environment': 'environment' }

/**
 * The key a log attribute is searched by, if it can be: `sentry.release` and `sentry.environment` by their columns,
 * no other `sentry.*` (ingest doesn't store them in log_attributes), nor a reserved name, nor one the grammar can't write
 */
export function logAttributeKey(key: string): string | undefined {
  if (key.startsWith('sentry.')) return SENTRY_COLUMNS[key]
  return isSearchableKey(key) && !LOG_RESERVED.has(key) ? key : undefined
}

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
 * `key:[…]` (or adds `key:value`); excluding adds it to `!key:[…]`; either takes it out of the other list. A key the
 * grammar can't write (`isSearchableKey`) leaves the query unchanged.
 */
export function addValue(query: string, key: string, value: string, negate: boolean): string {
  // A key the grammar can't write would come back as other tokens: leave the query as it is
  if (!isSearchableKey(key)) return query
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
    values: [
      'unresolved',
      'resolved',
      'ignored',
      'new',
      'regressed',
      'escalating',
      'ongoing',
      'assigned',
      'unassigned',
      'bookmarked',
      'unread',
    ],
  },
  { key: 'level', description: 'Level', kind: 'enum', values: ['fatal', 'error', 'warning', 'info', 'debug'] },
  { key: 'priority', description: 'Priority', kind: 'enum', values: ['high', 'medium', 'low'] },
  { key: 'type', description: 'Error, message or CSP report', kind: 'text' },
  { key: 'platform', description: 'SDK platform', kind: 'text' },
  { key: 'firstRelease', description: 'Release it first appeared in', kind: 'text' },
  { key: 'lastRelease', description: 'Release it last appeared in', kind: 'text' },
  { key: 'project', description: 'Project', kind: 'text' },
  { key: 'has', description: 'Has a tag', kind: 'enum' },
  { key: 'times', description: 'Number of events', kind: 'number' },
  { key: 'users', description: 'Number of users affected', kind: 'number' },
  { key: 'lastSeen', description: 'Time of the last event, such as -24h', kind: 'time', values: WITHIN },
  { key: 'firstSeen', description: 'Time of the first event, such as -24h', kind: 'time', values: WITHIN },
  { key: 'trace', description: 'Has an event in this trace', kind: 'text' },
  { key: 'assigned', description: 'Assigned to, such as me or an email', kind: 'text' },
]

export const LOG_KEYS: KeyInfo[] = [
  { key: 'level', description: 'Level', kind: 'enum', values: ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] },
  { key: 'release', description: 'Release', kind: 'text' },
  { key: 'environment', description: 'Environment', kind: 'text' },
  { key: 'message', description: 'Text in the message', kind: 'text' },
  { key: 'trace', description: 'Trace ID', kind: 'text' },
  { key: 'timestamp', description: 'Time it was logged, such as -1h', kind: 'time', values: WITHIN },
  { key: 'has', description: 'Has an attribute', kind: 'enum' },
  { key: 'project', description: 'Project', kind: 'text' },
]

/** Explore's keys: events, one by one, across issues */
export const EVENT_KEYS: KeyInfo[] = [
  { key: 'level', description: 'Level', kind: 'enum', values: ['fatal', 'error', 'warning', 'info', 'debug'] },
  { key: 'release', description: 'Release', kind: 'text' },
  { key: 'environment', description: 'Environment', kind: 'text' },
  { key: 'platform', description: 'SDK platform', kind: 'text' },
  { key: 'is', description: 'Status of its issue', kind: 'enum', values: ['unresolved', 'resolved', 'ignored'] },
  { key: 'issue', description: 'Issue ID', kind: 'number' },
  { key: 'project', description: 'Project', kind: 'text' },
  { key: 'trace', description: 'Trace ID', kind: 'text' },
  { key: 'timestamp', description: 'Time it was received, such as -1h', kind: 'time', values: WITHIN },
  { key: 'has', description: 'Has a tag', kind: 'enum' },
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
  priority: 'i.priority',
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
export function matchAny(column: string, values: string[]): [string, unknown[]] {
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

function status(value: string, now: number, viewer?: string): [string, unknown[]] | undefined {
  if (STATUSES.has(value)) return ['i.status = ?', [value]]
  if (value === 'assigned') return ['i.assignee IS NOT NULL', []]
  if (value === 'unassigned') return ['i.assignee IS NULL', []]
  // The viewer's own: with no viewer (a widget, an alert) nothing is bookmarked and everything is unread
  if (value === 'bookmarked')
    return viewer ? ['EXISTS (SELECT 1 FROM bookmarks b WHERE b.email = ? AND b.issue_id = i.id)', [viewer]] : ['0', []]
  if (value === 'unread') return viewer ? [UNREAD, [viewer]] : ['1', []]
  if (value === 'new') return ["i.status = 'unresolved' AND i.substatus = 'new' AND i.first_seen >= ?", [now - NEW_FOR]]
  if (value === 'ongoing')
    return [
      "i.status = 'unresolved' AND (i.substatus = 'ongoing' OR (i.substatus = 'new' AND i.first_seen < ?))",
      [now - NEW_FOR],
    ]
  if (value === 'regressed') return ["i.status = 'unresolved' AND i.substatus = 'regressed'", []]
  if (value === 'escalating') return ["i.status = 'unresolved' AND i.substatus = 'escalating'", []]
}

// As Sentry: `lastSeen:-24h` is within the last day, `lastSeen:+24h` longer ago; `<-24h` reads "less than a day ago"
function timeOp(t: Token) {
  if (t.op === ':') return t.value.startsWith('+') ? '<' : '>='
  return t.value.startsWith('-') ? { '>': '<', '<': '>', '>=': '<=', '<=': '>=' }[t.op] : SQL_OP[t.op]
}

export type Filter = { where: string[]; params: unknown[]; projectSlugs: string[] }

/** Unread for a viewer: events since they last opened it, or never opened; one `?`, the viewer's email */
export const UNREAD =
  'NOT EXISTS (SELECT 1 FROM issue_views v WHERE v.email = ? AND v.issue_id = i.id AND v.at >= i.last_seen)'

/** SQL conditions over `issues i` for a query. Unknown keys are tags (issue_tag_values): "had an event with it" */
export function issueFilter(query: string, now: number, viewer?: string): Filter {
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
      const parts = values.map((v) => status(v, now, viewer)).filter((p) => p !== undefined)
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
    if (key === 'assigned') {
      // `me` is the viewer; with none it matches no one
      const emails = values.map((v) => (v === 'me' ? (viewer ?? '\u0000') : v))
      const [sql, matched] = matchAny('i.assignee', emails)
      add(sql, t.negate, ...matched)
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

const EVENT_COLUMNS: Record<string, string> = {
  level: 'e.level',
  release: 'e.release',
  environment: 'e.environment',
  platform: 'e.platform',
  trace: 'e.trace_id',
}

/**
 * SQL conditions over `events e`, for Explore and an issue's event search. Unknown keys are the event's own tags
 * (`event_tags`); words are text in its title and message, case-insensitive. Every value is a bound parameter
 */
export function eventFilter(query: string, now: number): Filter {
  const where: string[] = []
  const params: unknown[] = []
  const projectSlugs: string[] = []
  const add = (sql: string, negate: boolean, ...values: unknown[]) => {
    where.push(negate ? `NOT (${sql})` : sql)
    params.push(...values)
  }
  for (const t of tokenize(query)) {
    if (!t.key || t.key === 'message') {
      for (const text of t.values ?? [t.value]) if (text) add('instr(lower(e.message), lower(?)) > 0', t.negate, text)
      continue
    }
    const key = t.key
    const values = valuesOf(t)
    if (key === 'project') {
      if (!t.negate) projectSlugs.push(...values)
      else {
        const [sql, slugs] = matchAny('slug', values)
        add(`e.project_id NOT IN (SELECT id FROM projects WHERE ${sql})`, false, ...slugs)
      }
      continue
    }
    if (key === 'is') {
      const known = values.filter((v) => STATUSES.has(v))
      if (known.length) {
        const [sql, statuses] = matchAny('i.status', known)
        add(`EXISTS (SELECT 1 FROM issues i WHERE i.id = e.issue_id AND ${sql})`, t.negate, ...statuses)
      }
      continue
    }
    if (key === 'issue' || key === 'issue.id') {
      const ids = values.map(Number).filter(Number.isInteger)
      if (ids.length) add(`e.issue_id IN (${ids.map(() => '?').join(',')})`, t.negate, ...ids)
      continue
    }
    if (key === 'timestamp') {
      const at = t.values ? undefined : timeOf(t.value, now)
      if (at !== undefined) add(`e.received ${timeOp(t)} ?`, t.negate, at)
      continue
    }
    if (key === 'has') {
      const [sql, keys] = matchAny('t.key', values)
      add(`EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND ${sql})`, t.negate, ...keys)
      continue
    }
    if (EVENT_COLUMNS[key]) {
      const [sql, matched] = matchAny(EVENT_COLUMNS[key], values)
      add(sql, t.negate, ...matched)
      continue
    }
    const [sql, matched] = matchAny('t.value', values)
    add(
      `EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.key = ? AND ${sql})`,
      t.negate,
      key,
      ...matched,
    )
  }
  return { where, params, projectSlugs }
}
