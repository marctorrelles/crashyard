// The deployment's settings (one JSON value per key, who changed it and when) and each viewer's preferences (by their
// email). Pages read both through src/fns.ts; ingest and the cron read settings directly.

/** A setting, or `fallback` when it's unset or no longer JSON */
export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

/** `by` is the viewer's email, or null for the worker itself (the cron's heartbeat) */
export const setSetting = (db: D1Database, key: string, value: unknown, by: string | null, now = Date.now()) =>
  db
    .prepare(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value), by, now)
    .run()

// The keys settings are kept under
const DEFAULTS_KEY = 'defaults.project'
/** Field names to scrub at ingest, on top of the built-in ones (src/ingest/scrub.ts) */
export const SCRUB_KEY = 'privacy.scrub_fields'
/** When the cron last ran, in ms: written each minute, late on Settings, Health after 3 minutes */
export const CRON_KEY = 'cron.last_run'
/** Every Worker whose runs reach `tail()`, by name, with when one was last noted: `{ name: ms }` (src/api/tail.ts) */
export const WORKERS_KEY = 'tail.workers'

/** What a new project starts with: the columns' own defaults until changed on Settings, Projects */
export type ProjectDefaults = {
  daily_event_quota: number
  daily_log_quota: number
  daily_transaction_quota: number
  event_retention_days: number
  log_retention_days: number
}
export const PROJECT_DEFAULTS: ProjectDefaults = {
  daily_event_quota: 10_000,
  daily_log_quota: 10_000,
  daily_transaction_quota: 10_000,
  event_retention_days: 90,
  log_retention_days: 30,
}
export const projectDefaults = async (db: D1Database) => ({
  ...PROJECT_DEFAULTS,
  ...(await getSetting<Partial<ProjectDefaults>>(db, DEFAULTS_KEY, {})),
})

export const STYLES = ['hazard', 'classic', 'terminal', 'soft', 'editorial'] as const
export type Preferences = {
  theme: 'system' | 'light' | 'dark'
  style: (typeof STYLES)[number] // the theme's look, src/styles.css; `theme` is light or dark
  timeZone?: string // an IANA zone; unset is the browser's
  clock: '24' | '12'
  stackOrder: 'newest' | 'oldest' // newest: the crashing frame on top, as Sentry
  showOtherFrames: boolean // frames outside the app open, not folded
  homeProject?: string // a slug: the overview opens on it
  homeRange?: string // the overview's charts: 14, 30 or 90 days
}
export const PREFERENCES: Preferences = {
  theme: 'system',
  style: 'hazard',
  clock: '24',
  stackOrder: 'newest',
  showOtherFrames: false,
}

/** A viewer's preferences over the defaults; a value that isn't JSON is skipped */
export async function getPreferences(db: D1Database, email: string): Promise<Preferences> {
  const { results } = await db
    .prepare('SELECT key, value FROM preferences WHERE email = ?')
    .bind(email)
    .all<{ key: string; value: string }>()
  const prefs: Record<string, unknown> = { ...PREFERENCES }
  for (const r of results) {
    try {
      prefs[r.key] = JSON.parse(r.value)
    } catch {
      // skipped: the default stands
    }
  }
  return prefs as Preferences
}

/** `undefined` (or null) clears it back to the default */
export const setPreference = <K extends keyof Preferences>(
  db: D1Database,
  email: string,
  key: K,
  value: Preferences[K] | null | undefined,
) =>
  value === undefined || value === null
    ? db.prepare('DELETE FROM preferences WHERE email = ? AND key = ?').bind(email, key).run()
    : db
        .prepare(
          'INSERT INTO preferences (email, key, value) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value',
        )
        .bind(email, key, JSON.stringify(value))
        .run()
