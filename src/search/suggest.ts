// What the search bar proposes at the caret: a key, a value of the key being typed, or an operator. Pure: the bar
// feeds it the keys and values the server found (src/data/suggest.ts) and applies what's picked back to the text.
import { type KeyInfo, listItems, quote, scan, type Token } from './query'

export type Suggestion =
  | { kind: 'key'; key: string; description: string }
  | { kind: 'value'; key: string; value: string; count?: number }
  | { kind: 'operator'; key: string; op: Token['op'] | '!' }

/** Where the caret is: typing a key (or a free word), or the value of `key`; `prefix` is what's typed of it */
export type Context = {
  tokenIndex: number
  part: 'key' | 'value'
  key?: string
  prefix: string
  negate?: boolean
  op?: Token['op']
}

type Catalogue = { keys: KeyInfo[]; values: { value: string; count: number }[] }

// The context plus the text it covers: the token's [start, end), where its value starts, and, in a `[…]` list,
// which item the caret is in
type Spot = Context & { start: number; end: number; valueStart: number; list?: number }

const HEAD = /^(!)?([\w.-]+):(>=|<=|>|<)?/

// The commas outside quotes before the caret in a list, and the item being typed
function partial(inside: string): { index: number; prefix: string } {
  let index = 0
  let start = 0
  let quoted = false
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] === '\\') i++
    else if (inside[i] === '"') quoted = !quoted
    else if (inside[i] === ',' && !quoted) {
      index++
      start = i + 1
    }
  }
  return { index, prefix: listItems(inside.slice(start))[0] }
}

function locate(query: string, caret: number): Spot {
  const spans = scan(query)
  let tokenIndex = 0
  for (const s of spans) {
    if (s.start >= caret) break
    if (caret <= s.end) {
      const text = query.slice(s.start, s.end)
      const head = HEAD.exec(text)
      const valueStart = s.start + (head?.[0].length ?? 0)
      if (head && caret >= valueStart) {
        const at = {
          tokenIndex,
          part: 'value' as const,
          key: head[2],
          negate: !!head[1],
          op: (head[3] ?? ':') as Token['op'],
        }
        const typed = query.slice(valueStart, caret)
        if (typed.startsWith('[')) {
          const { index, prefix } = partial(typed.slice(1))
          return { ...at, prefix, start: s.start, end: s.end, valueStart, list: index }
        }
        const prefix = typed.startsWith('"') ? typed.slice(1).replace(/\\(.)/g, '$1') : typed
        return { ...at, prefix, start: s.start, end: s.end, valueStart }
      }
      const typed = query.slice(s.start, caret)
      return {
        tokenIndex,
        part: 'key',
        prefix: typed.replace(/^!/, ''),
        negate: typed.startsWith('!'),
        // Typing in the key of a whole `key:value`: only the key is replaced
        start: s.start,
        end: head ? valueStart : s.end,
        valueStart,
      }
    }
    if (s.token.value !== '') tokenIndex++
  }
  return { tokenIndex, part: 'key', prefix: '', negate: false, start: caret, end: caret, valueStart: caret }
}

/** The caret's context in a query */
export function contextAt(query: string, caret: number): Context {
  const { tokenIndex, part, key, prefix, negate, op } = locate(query, caret)
  return part === 'key' ? { tokenIndex, part, prefix, negate } : { tokenIndex, part, key, prefix, negate, op }
}

// Starting with the prefix first, then containing it; case-insensitive
function rank<T>(items: T[], name: (t: T) => string, prefix: string): T[] {
  const p = prefix.toLowerCase()
  const starts = items.filter((i) => name(i).toLowerCase().startsWith(p))
  if (!p) return starts
  return [...starts, ...items.filter((i) => !name(i).toLowerCase().startsWith(p) && name(i).toLowerCase().includes(p))]
}

const COMPARE = ['>', '<', '>=', '<='] as const

/**
 * What to propose for a context: keys (the catalogue's order: built-ins, then stored tags), or a key's values (its
 * enum, the tags for `has:`, else the catalogue's values) and, before anything is typed, `!` and comparisons.
 */
export function suggest(ctx: Context, catalogue: Catalogue): Suggestion[] {
  if (ctx.part === 'key')
    return rank(catalogue.keys, (k) => k.key, ctx.prefix)
      .slice(0, 50)
      .map((k) => ({ kind: 'key', key: k.key, description: k.description }))
  const key = ctx.key ?? ''
  const info = catalogue.keys.find((k) => k.key === key)
  const values: { value: string; count?: number }[] = info?.values
    ? info.values.map((value) => ({ value }))
    : key === 'has'
      ? catalogue.keys.filter((k) => k.kind === 'tag').map((k) => ({ value: k.key }))
      : catalogue.values
  const out: Suggestion[] = rank(values, (v) => v.value, ctx.prefix)
    .slice(0, 20)
    .map((v) => ({ kind: 'value', key, value: v.value, ...(v.count === undefined ? {} : { count: v.count }) }))
  if (ctx.prefix === '') {
    if (!ctx.negate) out.push({ kind: 'operator', key, op: '!' })
    if (info?.kind === 'number' || info?.kind === 'time')
      for (const op of COMPARE) if (op !== ctx.op) out.push({ kind: 'operator', key, op })
  }
  return out
}

/** The query with a suggestion applied at the caret, and where the caret goes */
export function apply(query: string, caret: number, s: Suggestion): { query: string; caret: number } {
  const spot = locate(query, caret)
  const before = query.slice(0, spot.start)
  let after = query.slice(spot.end)
  const neg = spot.negate ? '!' : ''
  if (s.kind === 'key') {
    const text = `${neg}${s.key}:`
    // Before a word with no space between, add one
    if (spot.start === spot.end && /^\S/.test(after)) after = ` ${after}`
    return { query: before + text + after, caret: before.length + text.length }
  }
  if (s.kind === 'operator') {
    const value = query.slice(spot.valueStart, spot.end)
    const head =
      s.op === '!' ? `${neg ? '' : '!'}${s.key}:${spot.op === ':' ? '' : (spot.op ?? '')}` : `${neg}${s.key}:${s.op}`
    return { query: before + head + value + after, caret: before.length + head.length + (caret - spot.valueStart) }
  }
  const head = spot.part === 'value' ? `${neg}${s.key}:${spot.op === ':' ? '' : (spot.op ?? '')}` : `${s.key}:`
  let value = quote(s.value)
  if (spot.list !== undefined) {
    const items = listItems(query.slice(spot.valueStart + 1, spot.end).replace(/\]$/, ''))
    items[spot.list] = s.value
    value = `[${[...new Set(items.filter((v) => v !== ''))].map(quote).join(',')}]`
  }
  const text = head + value
  if (!/^\s/.test(after)) after = ` ${after}`
  return { query: before + text + after, caret: before.length + text.length + 1 }
}
