// An event's size budget: what's stored in D1 stays under 900 KB of JSON (D1 holds 2 MB a row, and pages read it
// whole). Cuts go from least to most missed, each only while the event is still over, and `_trimmed` names them.
import { MAX_THREADS, type NormalizedEvent, THREAD_FRAMES } from './event'

export const EVENT_BUDGET = 900_000
const BREADCRUMBS = 100
const FRAMES = 200 // of an exception's, the innermost: the crashing frame and those nearest it
const LONG_TEXT = 4096

const encoder = new TextEncoder()
const sizeOf = (json: string) => (json.length * 3 <= EVENT_BUDGET ? json.length : encoder.encode(json).length)

/** The event as stored: its JSON, trimmed first when it's over the budget */
export function eventJson(event: NormalizedEvent, maxBytes = EVENT_BUDGET): string {
  const json = JSON.stringify(event)
  return json.length <= maxBytes && sizeOf(json) <= maxBytes ? json : JSON.stringify(trimEvent(event, maxBytes))
}

/** Texts longer than 4 KB cut short, anywhere in a value; whether any was */
function cutLong(value: unknown): [unknown, boolean] {
  if (typeof value === 'string')
    return value.length > LONG_TEXT ? [`${value.slice(0, LONG_TEXT - 1)}…`, true] : [value, false]
  if (!value || typeof value !== 'object') return [value, false]
  let cut = false
  const each = (v: unknown) => {
    const [out, c] = cutLong(v)
    cut ||= c
    return out
  }
  if (Array.isArray(value)) return [value.map(each), cut]
  return [Object.fromEntries(Object.entries(value).map(([k, v]) => [k, each(v)])), cut]
}

/** Does `cut` when `when` holds; whether it did */
const drop = (when: () => boolean, cut: () => unknown) => {
  if (!when()) return false
  cut()
  return true
}

export function trimEvent(event: NormalizedEvent, maxBytes = EVENT_BUDGET): NormalizedEvent {
  const size = (e: NormalizedEvent) => encoder.encode(JSON.stringify(e)).length
  if (size(event) <= maxBytes) return event
  const e: NormalizedEvent = structuredClone(event)
  const trimmed = new Set(e._trimmed ?? [])
  const rank = (t: NonNullable<NormalizedEvent['threads']>[number]) => (t.crashed ? 2 : t.current ? 1 : 0)
  // Each cut says whether it changed anything
  const cuts: [string, () => boolean][] = [
    [
      'breadcrumbs',
      () =>
        drop(
          () => e.breadcrumbs.length > BREADCRUMBS,
          () => (e.breadcrumbs = e.breadcrumbs.slice(-BREADCRUMBS)),
        ),
    ],
    [
      'threads',
      () => {
        const threads = e.threads ?? []
        const over = threads.length > MAX_THREADS || threads.some((t) => t.frames.length > THREAD_FRAMES)
        if (over)
          e.threads = [...threads]
            .sort((a, b) => rank(b) - rank(a))
            .slice(0, MAX_THREADS)
            .map((t) => ({ ...t, frames: t.frames.slice(-THREAD_FRAMES) }))
        return over
      },
    ],
    [
      'frames',
      () => {
        const over = e.exceptions.some((x) => x.frames.length > FRAMES)
        for (const x of e.exceptions) x.frames = x.frames.slice(-FRAMES)
        return over
      },
    ],
    ...(['contexts', 'extra', 'breadcrumbs', 'request', 'exceptions', 'tags', 'message'] as const).map(
      (key): [string, () => boolean] => [
        key,
        () => {
          const [out, cut] = cutLong(e[key])
          if (cut) Object.assign(e, { [key]: out })
          return cut
        },
      ],
    ),
    // Still over: whole parts go, the least missed first
    [
      'threads',
      () =>
        drop(
          () => (e.threads?.length ?? 0) > 1,
          () => (e.threads = e.threads!.slice(0, 1)),
        ),
    ],
    [
      'breadcrumbs',
      () =>
        drop(
          () => e.breadcrumbs.some((b) => b.data !== undefined),
          () => e.breadcrumbs.forEach((b) => delete b.data),
        ),
    ],
    [
      'contexts',
      () =>
        drop(
          () => Object.keys(e.contexts).length > 0,
          () => (e.contexts = {}),
        ),
    ],
    [
      'extra',
      () =>
        drop(
          () => e.extra !== undefined,
          () => delete e.extra,
        ),
    ],
    [
      'request',
      () =>
        drop(
          () => e.request !== undefined,
          () => delete e.request,
        ),
    ],
    [
      'breadcrumbs',
      () =>
        drop(
          () => e.breadcrumbs.length > 0,
          () => (e.breadcrumbs = []),
        ),
    ],
    [
      'frames',
      () =>
        drop(
          () => e.exceptions.some((x) => x.frames.length > 20),
          () => e.exceptions.forEach((x) => (x.frames = x.frames.slice(-20))),
        ),
    ],
    [
      'threads',
      () =>
        drop(
          () => e.threads !== undefined,
          () => delete e.threads,
        ),
    ],
  ]
  for (const [name, cut] of cuts) {
    if (cut()) trimmed.add(name)
    if (size({ ...e, _trimmed: [...trimmed] }) <= maxBytes) break
  }
  e._trimmed = [...trimmed]
  return e
}
