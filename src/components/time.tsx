// Dates and times as the viewer chose them on Settings, Preferences: their time zone (else the browser's, from the
// root's `tz` cookie, else UTC on a first visit) and a 12 or 24-hour clock. The zone comes from the root's loader, so
// the server and the browser write the same text and nothing shifts on hydration.
import { getRouteApi } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

export type TimePrefs = { zone: string; clock: '12' | '24' }

const STYLES = {
  datetime: { dateStyle: 'medium', timeStyle: 'short' },
  date: { dateStyle: 'medium' },
  time: { hour: '2-digit', minute: '2-digit' },
  seconds: { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 },
  day: { month: 'short', day: 'numeric' },
  weekday: { weekday: 'short', month: 'short', day: 'numeric' },
  dayTime: { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  full: { dateStyle: 'full', timeStyle: 'long' },
  key: { year: 'numeric', month: '2-digit', day: '2-digit' }, // the day it is in the zone, to compare
} satisfies Record<string, Intl.DateTimeFormatOptions>
export type TimeStyle = keyof typeof STYLES

const formats = new Map<string, Intl.DateTimeFormat>()

/** `at` (ms) in the viewer's zone and clock; an unknown zone falls back to UTC */
export function formatTime(at: number, prefs: TimePrefs, style: TimeStyle = 'datetime') {
  const id = `${prefs.zone}|${prefs.clock}|${style}`
  let format = formats.get(id)
  if (!format) {
    const options = { ...STYLES[style], hourCycle: prefs.clock === '12' ? 'h12' : 'h23' } as const
    try {
      format = new Intl.DateTimeFormat('en', { ...options, timeZone: prefs.zone })
    } catch {
      format = new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' })
    }
    formats.set(id, format)
  }
  return format.format(at)
}

const root = getRouteApi('__root__')

/** The viewer's zone and clock, from the root's loader */
export function useTimePrefs(): TimePrefs {
  const { zone, preferences } = root.useLoaderData()
  return { zone, clock: preferences.clock }
}

/** A time on a page, in the viewer's zone and clock; its title has the whole date and the zone */
export function Time({ at, style, className }: { at: number; style?: TimeStyle; className?: string }) {
  const prefs = useTimePrefs()
  return (
    <time dateTime={new Date(at).toISOString()} title={formatTime(at, prefs, 'full')} className={cn(className)}>
      {formatTime(at, prefs, style)}
    </time>
  )
}
