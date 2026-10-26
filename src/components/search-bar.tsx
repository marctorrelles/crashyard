// The search bar: every `key:value` of the query as a pill (key · operator · value; `is:` without its key), the rest as text, and a popover
// that proposes keys, values and operators for the caret (src/search/suggest.ts) with values the server has seen.
// The query stays the one truth: pills are tokens of it, and every pill change hands the whole query to `onSearch`.
import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useRouter } from '@tanstack/react-router'
import {
  IconBookmark,
  IconPin,
  IconPinFilled,
  IconPinnedOff,
  IconPlus,
  IconSearch,
  IconTrash,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Command, CommandGroup, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SavedSearch, SearchPage } from '@/data/searches'
import { deleteSearch, getSuggestions, pinSearch, saveSearch } from '@/fns'
import { EVENT_KEYS, ISSUE_KEYS, type KeyInfo, LOG_KEYS, type Token, tokenize, unparse } from '@/search/query'
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

// A pill's parts: as tall as the pill, square inside it, a hairline between each; on a phone each reaches past it to a 44 px tap
const PILL =
  'relative h-full rounded-none px-1.5 font-normal max-sm:px-2 max-sm:text-sm max-sm:after:absolute max-sm:after:inset-x-0 max-sm:after:-inset-y-1.5'

export function SearchBar({
  scope,
  query,
  project,
  range,
  placeholder,
  onSearch,
  onChange,
}: {
  scope: 'issues' | 'logs' | 'events'
  query: string
  project?: string
  range?: string
  placeholder: string
  onSearch: (query: string) => void
  // The whole query as it stands in the bar, pills and typed text, each time it changes (searched or not)
  onChange?: (query: string) => void
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
  // One timer per kind of request: asking for values doesn't cancel the keys asked for on focus
  const timers = useRef<Partial<Record<'keys' | 'values', ReturnType<typeof setTimeout>>>>({})
  const asked = useRef(new Set<string>())

  const base = `${scope}|${project ?? ''}|${range ?? ''}`
  const stored = cache.get(`${base}|keys`)
  const keys =
    stored && 'keys' in stored
      ? stored.keys
      : scope === 'issues'
        ? ISSUE_KEYS
        : scope === 'events'
          ? EVENT_KEYS
          : LOG_KEYS
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

  const ask = (kind: 'keys' | 'values', id: string, data: { key?: string; prefix: string }, delay: number) => {
    if (cache.has(id) || asked.current.has(id)) return
    clearTimeout(timers.current[kind])
    timers.current[kind] = setTimeout(() => {
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
    ask('values', `${base}|${at.key}|${at.prefix}`, { key: at.key, prefix: at.prefix }, DEBOUNCE)
  }

  // Text and caret together, with the caret placed once the input shows the new text
  const edit = (next: { pills?: Token[]; text: string }, from: number, to = from) => {
    onChange?.(join(next.pills ?? pills, next.text))
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
    onChange?.(join(nextPills, nextText))
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
    // While an IME composes, its keys (Enter to confirm a word) are the IME's, not the bar's
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
            <IconSearch />
          </InputGroupAddon>
          {pills.map((t, i) => {
            const info = keys.find((k) => k.key === t.key)
            const compare = info?.kind === 'number' || info?.kind === 'time'
            const shownValue = t.values ? t.values.join(', ') : t.value
            return (
              <span
                key={`${i} ${unparse([t])}`}
                role="group"
                aria-label={`${t.key} ${operatorLabel(t)} ${shownValue}`}
                className="flex h-6 max-w-full min-w-0 items-stretch overflow-hidden rounded-md border bg-muted/60 *:not-first:border-l-border max-sm:h-8"
              >
                {/* `is:unresolved` reads "is · unresolved": its key would say "is" twice */}
                {t.key !== 'is' && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className={`${PILL} text-muted-foreground`}
                    onClick={() => unpill(i, true)}
                  >
                    {t.key}
                  </Button>
                )}
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
                <Button
                  variant="ghost"
                  size="xs"
                  className={`${PILL} min-w-0 font-semibold`}
                  onClick={() => unpill(i, true)}
                >
                  <span className="truncate">{shownValue}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className={`${PILL} w-6 px-0 text-muted-foreground max-sm:w-8 max-sm:px-0`}
                  aria-label={`Remove ${t.key}`}
                  onClick={() =>
                    search(
                      pills.filter((_, j) => j !== i),
                      text,
                    )
                  }
                >
                  <IconX />
                </Button>
              </span>
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
              onChange?.(join(pills, next))
              setDraft((d) => ({ ...d, text: next }))
              setCaret(at)
              setHighlight(-1)
              setOpen(true)
              askValues(next, at)
            }}
            onSelect={(e) => setCaret(caretOf(e))}
            onFocus={(e) => {
              setOpen(true)
              ask('keys', `${base}|keys`, { prefix: '' }, 0)
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

/**
 * "Saved searches" beside a search bar: the viewer's pinned one first, then their own and everyone's shared ones; a
 * pick searches it. Each of the viewer's own can be pinned, opening the page by default, or deleted. "Save search"
 * names the current one and can share it with everyone
 */
export function SavedSearches({
  page,
  query,
  searches,
  onPick,
}: {
  page: SearchPage
  query: string
  searches: SavedSearch[]
  onPick: (query: string) => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (f: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await f()
      await router.invalidate()
      toast.success(done)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That didn’t work. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="max-sm:h-10">
            <IconBookmark data-icon="inline-start" />
            Saved searches
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-1">
          {searches.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              No saved searches yet. Save one to come back to it in a click.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {searches.map((s) => (
                <li key={s.id} className="group flex items-center gap-1 rounded-md hover:bg-muted/60">
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2 py-1.5 text-left max-sm:min-h-10"
                    onClick={() => {
                      setOpen(false)
                      onPick(s.query)
                    }}
                  >
                    <span className="flex items-center gap-1.5 text-sm">
                      <span className="truncate">{s.name}</span>
                      {s.pinned && (
                        <IconPinFilled className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
                      )}
                      {s.shared && <IconUsers className="size-3 shrink-0 text-muted-foreground" aria-label="Shared" />}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {s.query || 'Everything'}
                      {!s.mine && ` · ${s.email}`}
                    </span>
                  </button>
                  {s.mine && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="max-sm:size-10"
                        disabled={busy}
                        aria-label={s.pinned ? `Unpin ${s.name}` : `Pin ${s.name}`}
                        title={s.pinned ? 'Unpin' : 'Pin, so the page opens with it'}
                        onClick={() =>
                          run(
                            () => pinSearch({ data: { id: s.id, pinned: !s.pinned } }),
                            s.pinned ? 'Unpinned' : 'Pinned',
                          )
                        }
                      >
                        {s.pinned ? <IconPinnedOff /> : <IconPin />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="max-sm:size-10"
                        disabled={busy}
                        aria-label={`Delete ${s.name}`}
                        onClick={() => {
                          if (confirm(`Delete the saved search ${s.name}?`))
                            void run(() => deleteSearch({ data: { id: s.id } }), 'Deleted')
                        }}
                      >
                        <IconTrash />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="border-t p-1">
            <Button
              variant="ghost"
              className="w-full justify-start max-sm:h-10"
              onClick={() => {
                setOpen(false)
                setSaving(true)
              }}
            >
              <IconPlus data-icon="inline-start" />
              Save search
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {saving && (
        <Dialog open onOpenChange={(o) => !o && setSaving(false)}>
          <DialogContent>
            <form
              className="contents"
              onSubmit={(e) => {
                e.preventDefault()
                const f = new FormData(e.currentTarget)
                void run(
                  () =>
                    saveSearch({
                      data: { page, name: String(f.get('name')), query, shared: f.get('shared') === 'on' },
                    }),
                  'Saved',
                ).then(() => setSaving(false))
              }}
            >
              <DialogHeader>
                <DialogTitle>Save search</DialogTitle>
                <DialogDescription className="font-mono break-all">{query || 'Everything'}</DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="search-name">Name</Label>
                <Input
                  id="search-name"
                  name="name"
                  required
                  maxLength={80}
                  autoComplete="off"
                  placeholder="Fatal on iOS"
                />
              </div>
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox name="shared" />
                Share with everyone
              </Label>
              <DialogFooter>
                <Button type="submit" disabled={busy}>
                  Save search
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
