// When a cron monitor's next check-in is due: Sentry's schedules, a crontab (in a time zone) or an interval.
// Crontab: minute hour day-of-month month day-of-week, each `*`, a number, a list, a range, a step (`*/15`, `1-5/2`),
// with `@daily` and friends; day-of-week 0 or 7 is Sunday. As cron does, when both day fields are restricted, a
// day matching either runs.

export type Schedule = { type: 'crontab'; value: string } | { type: 'interval'; value: number; unit: Unit }
type Unit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

const MINUTE = 60_000
const UNIT_MS: Record<Exclude<Unit, 'month' | 'year'>, number> = {
  minute: MINUTE,
  hour: 60 * MINUTE,
  day: 1440 * MINUTE,
  week: 10080 * MINUTE,
}
const ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

function field(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/)
    if (!m) throw new Error(`can't read "${text}"`)
    const step = m[3] ? Number(m[3]) : 1
    const from = m[1] === '*' ? min : Number(m[1])
    const to = m[1] === '*' ? max : m[2] ? Number(m[2]) : m[3] ? max : from
    if (from < min || to > max || from > to || step < 1) throw new Error(`"${text}" is out of range`)
    for (let v = from; v <= to; v += step) values.add(v)
  }
  return values
}

export type Crontab = {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  anyDay: boolean
  anyWeekday: boolean
}

export function parseCrontab(text: string): Crontab {
  const parts = (ALIASES[text.trim()] ?? text).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('a crontab has five fields: minute hour day month weekday')
  const weekdays = field(parts[4], 0, 7)!
  if (weekdays.has(7)) weekdays.add(0)
  return {
    minutes: field(parts[0], 0, 59)!,
    hours: field(parts[1], 0, 23)!,
    days: field(parts[2], 1, 31)!,
    months: field(parts[3], 1, 12)!,
    weekdays,
    anyDay: parts[2] === '*',
    anyWeekday: parts[4] === '*',
  }
}

// The wall-clock parts of an instant in a time zone
const formats = new Map<string, Intl.DateTimeFormat>()
function partsIn(ms: number, timeZone: string) {
  let f = formats.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formats.set(timeZone, f)
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]))
  return {
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
  }
}

/** The first minute after `after` the crontab runs, in `timeZone` (default UTC); a year out at most */
export function nextCrontab(cron: Crontab, after: number, timeZone = 'UTC'): number {
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const limit = t + 366 * 1440 * MINUTE
  while (t < limit) {
    const p = partsIn(t, timeZone)
    const dayOk =
      cron.anyDay && cron.anyWeekday
        ? true
        : cron.anyDay
          ? cron.weekdays.has(p.weekday)
          : cron.anyWeekday
            ? cron.days.has(p.day)
            : cron.days.has(p.day) || cron.weekdays.has(p.weekday)
    // Skip what can't match: the rest of the day, then of the hour (by wall-clock minutes, so DST is safe)
    if (!cron.months.has(p.month) || !dayOk) t += ((23 - p.hour) * 60 + (60 - p.minute)) * MINUTE
    else if (!cron.hours.has(p.hour)) t += (60 - p.minute) * MINUTE
    else if (!cron.minutes.has(p.minute)) t += MINUTE
    else return t
  }
  throw new Error('this crontab never runs')
}

/** When the next run is due after one at (or the check-in at) `after` */
export function nextRun(schedule: Schedule, after: number, timeZone?: string): number {
  if (schedule.type === 'crontab') return nextCrontab(parseCrontab(schedule.value), after, timeZone)
  if (schedule.unit === 'month' || schedule.unit === 'year') {
    const d = new Date(after)
    if (schedule.unit === 'month') d.setUTCMonth(d.getUTCMonth() + schedule.value)
    else d.setUTCFullYear(d.getUTCFullYear() + schedule.value)
    return d.getTime()
  }
  return after + schedule.value * UNIT_MS[schedule.unit]
}

export const describeSchedule = (s: Schedule) =>
  s.type === 'crontab' ? s.value : `every ${s.value === 1 ? '' : `${s.value} `}${s.unit}${s.value === 1 ? '' : 's'}`
