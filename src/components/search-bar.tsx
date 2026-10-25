// The search bar: every `key:value` of the query as a pill (key · operator · value), the rest as text, and a popover
// that proposes keys, values and operators for the caret (src/search/suggest.ts) with values the server has seen.
// The query stays the one truth: pills are tokens of it, and every pill change hands the whole query to `onSearch`.
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { SearchIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { getSuggestions } from '@/fns'
import { ISSUE_KEYS, type KeyInfo, LOG_KEYS, type Token, tokenize, unparse } from '@/search/query'
import { apply, contextAt, type Suggestion, suggest } from '@/search/suggest'

type Values = { value: string; count: number }[]
type Reply = { keys: KeyInfo[] } | { values: Values }

// cmdk highlights its first item whenever its value is empty; a value no item has is "nothing highlighted", so a
// plain Enter searches instead of picking
const NOTHING = '\u0000'
const DEBOUNCE = 150

const OPERATORS: Record<string, string> = {
  '!': 'is not',
  '>': 'more than',
  '<': 'less than',
  '>=': 'at least',
  '<=': 'at most',
}

// The query as pills (tokens with a key) and the text left (free words), and back
function split(query: string) {
  const tokens = tokenize(query)
  return { pills: tokens.filter((t) => t.key), text: unparse(tokens.filter((t) => !t.key)) }
}
const join = (pills: Token[], text: string) => [unparse(pills), text.trim()].filter(Boolean).join(' ')

function operatorLabel(t: Token) {
  if (t.op !== ':') return `${t.negate ? 'not ' : ''}${OPERATORS[t.op]}`
  if (t.values) return t.negate ? 'is none of' : 'is one of'
  return t.negate ? 'is not' : 'is'
}

const idOf = (s: Suggestion) =>
  s.kind === 'key' ? `key ${s.key}` : s.kind === 'value' ? `value ${s.value}` : `operator ${s.op}`

const PILL = 'max-sm:h-10 max-sm:px-2.5'

export function SearchBar({
  scope,
  query,
  project,
  range,
  placeholder,
  onSearch,
}: {
  scope: 'issues' | 'logs'
  query: string
  project?: string
  range?: string
  placeholder: string
  onSearch: (query: string) => void
}) {
  // The pills and text, made again from `query` when it changes (a link, the back button); when it's the query the
  // bar just searched, what's in the bar stays as it is (the caret, a space typed after the text)
  const [draft, setDraft] = useState(() => ({ from: query, ...split(query) }))
  if (draft.from !== query)
    setDraft(join(draft.pills, draft.text) === query ? { ...draft, from: query } : { from: query, ...split(query) })
  const { pills, text } = draft
  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  // Replies by (scope, project, range, key, prefix), for the page's life: a late reply fills only its own entry, so
  // it never shows for what's typed since
  const [cache, setCache] = useState(() => new Map<string, Reply>())
  const input = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const asked = useRef(new Set<string>())

  const base = `${scope}|${project ?? ''}|${range ?? ''}`
  const stored = cache.get(`${base}|keys`)
  const keys = stored && 'keys' in stored ? stored.keys : scope === 'issues' ? ISSUE_KEYS : LOG_KEYS
  const ctx = contextAt(text, Math.min(caret, text.length))
  const values = (key: string, prefix: string): Values => {
    // While the reply for this prefix is on its way, the one for a shorter prefix (narrowed by `suggest`)
    for (let n = prefix.length; n >= 0; n--) {
      const hit = cache.get(`${base}|${key}|${prefix.slice(0, n)}`)
      if (hit && 'values' in hit) return hit.values
    }
    return []
  }
  const items =
    ctx.part === 'value' && ctx.key
      ? suggest(ctx, { keys, values: values(ctx.key, ctx.prefix) })
      : suggest(ctx, { keys, values: [] })
  const shown = open && items.length > 0

  const ask = (id: string, data: { key?: string; prefix: string }, delay: number) => {
    if (cache.has(id) || asked.current.has(id)) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      asked.current.add(id)
      getSuggestions({ data: { scope, project, range, ...data } }).then(
        (reply) => setCache((c) => new Map(c).set(id, reply)),
        () => asked.current.delete(id),
      )
    }, delay)
  }
  // The values for the caret's key, unless the bar knows them already (enums, numbers, times, `has:`)
  const askValues = (t: string, c: number) => {
    const at = contextAt(t, c)
    if (at.part !== 'value' || !at.key) return
    const info = keys.find((k) => k.key === at.key)
    if (info?.values || info?.kind === 'number' || at.key === 'has') return
    ask(`${base}|${at.key}|${at.prefix}`, { key: at.key, prefix: at.prefix }, DEBOUNCE)
  }

  // Text and caret together, with the caret placed once the input shows the new text
  const edit = (next: { pills?: Token[]; text: string }, from: number, to = from) => {
    flushSync(() => {
      setDraft((d) => ({ ...d, pills: next.pills ?? d.pills, text: next.text }))
      setCaret(from)
      setHighlight(-1)
      setOpen(true)
    })
    input.current?.focus()
    input.current?.setSelectionRange(from, to)
    askValues(next.text, from)
  }

  const search = (nextPills: Token[], nextText: string) => {
    setDraft((d) => ({ ...d, pills: nextPills, text: nextText }))
    onSearch(join(nextPills, nextText))
  }

  const choose = (s: Suggestion) => {
    const r = apply(text, Math.min(caret, text.length), s)
    if (s.kind !== 'value') return edit({ text: r.query }, r.caret)
    // A value finishes its token: it becomes a pill, and the query is searched
    const { pills: done, text: rest } = split(r.query)
    const next = rest ? `${rest} ` : ''
    edit({ pills: [...pills, ...done], text: next }, next.length)
    onSearch(join([...pills, ...done], next))
  }

  // A pill back into text, its value selected so typing replaces it and the popover shows the key's values
  const unpill = (i: number, selectValue: boolean) => {
    const t = pills[i]
    const token = unparse([t])
    const head = `${t.negate ? '!' : ''}${t.key}:${t.op === ':' ? '' : t.op}`.length
    edit(
      { pills: pills.filter((_, j) => j !== i), text: text ? `${token} ${text}` : token },
      selectValue ? head : token.length,
      token.length,
    )
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => (e.key === 'ArrowDown' ? Math.min(h + 1, items.length - 1) : Math.max(h - 1, -1)))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (shown && highlight >= 0 && items[highlight]) choose(items[highlight])
      else {
        setOpen(false)
        onSearch(join(pills, text))
      }
    } else if (e.key === 'Tab' && shown && !e.shiftKey) {
      e.preventDefault()
      choose(items[Math.max(highlight, 0)])
    } else if (e.key === 'Escape' && shown) {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Backspace' && text === '' && pills.length) {
      e.preventDefault()
      unpill(pills.length - 1, false)
    }
  }

  const caretOf = (e: React.SyntheticEvent<HTMLInputElement>) => e.currentTarget.selectionStart ?? 0

  return (
    <Popover open={shown} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <InputGroup ref={bar} className="h-auto min-h-8 flex-wrap gap-1 py-0.5 pr-1 max-sm:min-h-11">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          {pills.map((t, i) => {
            const info = keys.find((k) => k.key === t.key)
            const compare = info?.kind === 'number' || info?.kind === 'time'
            const shownValue = t.values ? t.values.join(', ') : t.value
            return (
              <ButtonGroup key={`${i} ${unparse([t])}`} className="max-w-full min-w-0 rounded-lg bg-muted">
                <Button variant="ghost" size="xs" className={PILL} onClick={() => unpill(i, true)}>
                  {t.key}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="xs"
                      className={`${PILL} text-muted-foreground`}
                      aria-label={`${t.key}: ${operatorLabel(t)}, change`}
                    >
                      {operatorLabel(t)}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuRadioGroup
                      value={`${t.negate ? '!' : ''}${t.op}`}
                      onValueChange={(v) => {
                        const negate = v.startsWith('!')
                        const op = (negate ? v.slice(1) : v) as Token['op']
                        search(
                          pills.map((p, j) => (j === i ? { ...p, negate, op } : p)),
                          text,
                        )
                      }}
                    >
                      <DropdownMenuRadioItem value=":">{t.values ? 'is one of' : 'is'}</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="!:">{t.values ? 'is none of' : 'is not'}</DropdownMenuRadioItem>
                      {compare &&
                        (['>', '<', '>=', '<='] as const).map((op) => (
                          <DropdownMenuRadioItem key={op} value={op}>
                            {OPERATORS[op]}
                          </DropdownMenuRadioItem>
                        ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="ghost" size="xs" className={`${PILL} min-w-0`} onClick={() => unpill(i, true)}>
                  <span className="truncate">{shownValue}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="max-sm:size-10"
                  aria-label={`Remove ${t.key}`}
                  onClick={() =>
                    search(
                      pills.filter((_, j) => j !== i),
                      text,
                    )
                  }
                >
                  <XIcon />
                </Button>
              </ButtonGroup>
            )
          })}
          <InputGroupInput
            ref={input}
            value={text}
            placeholder={pills.length ? undefined : placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-expanded={shown}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="h-7 min-w-28 px-1.5 max-sm:h-10"
            onChange={(e) => {
              const next = e.currentTarget.value
              const at = caretOf(e)
              setDraft((d) => ({ ...d, text: next }))
              setCaret(at)
              setHighlight(-1)
              setOpen(true)
              askValues(next, at)
            }}
            onSelect={(e) => setCaret(caretOf(e))}
            onFocus={(e) => {
              setOpen(true)
              ask(`${base}|keys`, { prefix: '' }, 0)
              askValues(text, caretOf(e))
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
          />
        </InputGroup>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) gap-0 p-0 sm:max-w-md"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Clicks in the bar (the input, a pill) aren't outside: the bar handles them
        onInteractOutside={(e) => {
          if (bar.current?.contains(e.target as Node)) e.preventDefault()
        }}
        // A click on a suggestion keeps the focus in the input
        onMouseDown={(e) => e.preventDefault()}
      >
        <Command
          shouldFilter={false}
          disablePointerSelection
          value={highlight >= 0 && items[highlight] ? idOf(items[highlight]) : NOTHING}
        >
          <CommandList>
            <CommandGroup heading={ctx.part === 'key' ? 'Keys' : ctx.key}>
              {items.map((s) => (
                <CommandItem
                  key={idOf(s)}
                  value={idOf(s)}
                  onSelect={() => choose(s)}
                  className="hover:bg-muted/60 max-sm:min-h-10"
                >
                  {s.kind === 'key' ? (
                    <>
                      <span className="font-medium">{s.key}</span>
                      <span className="truncate text-muted-foreground">{s.description}</span>
                    </>
                  ) : s.kind === 'value' ? (
                    <>
                      <span className="truncate">{s.value}</span>
                      {s.count !== undefined && (
                        <CommandShortcut className="tracking-normal tabular-nums">{s.count}</CommandShortcut>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {s.op === '!' ? `!${s.key}:` : `${s.key}:${s.op}`} {OPERATORS[s.op]}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground max-sm:hidden">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> pick
            </span>
            <span className="flex items-center gap-1">
              <Kbd>tab</Kbd> first
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
