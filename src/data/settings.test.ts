import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import {
  claimRun,
  getPreferences,
  getSetting,
  PREFERENCES,
  projectDefaults,
  setPreference,
  setSetting,
} from './settings'

describe('settings', () => {
  it('reads the fallback until a setting is set, then its JSON as written', async () => {
    const db = sqliteD1()
    expect(await getSetting(db, 'privacy.scrub_fields', ['none'])).toEqual(['none'])
    await setSetting(db, 'privacy.scrub_fields', ['iban', 'pin'], 'marc@example.com', 5)
    await setSetting(db, 'example.flag', true, null)
    expect(await getSetting(db, 'privacy.scrub_fields', [])).toEqual(['iban', 'pin'])
    expect(await getSetting(db, 'example.flag', false)).toBe(true)
    expect(
      db.sqlite.prepare("SELECT updated_by, updated_at FROM settings WHERE key = 'privacy.scrub_fields'").get(),
    ).toEqual({ updated_by: 'marc@example.com', updated_at: 5 })
    db.sqlite.exec("UPDATE settings SET value = 'not json' WHERE key = 'example.flag'")
    expect(await getSetting(db, 'example.flag', false)).toBe(false)
  })

  it('lays new-project defaults over the columns’ own', async () => {
    const db = sqliteD1()
    expect((await projectDefaults(db)).daily_event_quota).toBe(10_000)
    await setSetting(db, 'defaults.project', { daily_event_quota: 500 }, 'marc@example.com')
    expect(await projectDefaults(db)).toMatchObject({ daily_event_quota: 500, event_retention_days: 90 })
  })
})

describe('preferences', () => {
  it('keeps each viewer’s own, over the defaults, and clears back to them', async () => {
    const db = sqliteD1()
    expect(await getPreferences(db, 'a@example.com')).toEqual(PREFERENCES)
    await setPreference(db, 'a@example.com', 'theme', 'dark')
    await setPreference(db, 'a@example.com', 'timeZone', 'Europe/Madrid')
    await setPreference(db, 'b@example.com', 'clock', '12')
    expect(await getPreferences(db, 'a@example.com')).toEqual({
      ...PREFERENCES,
      theme: 'dark',
      timeZone: 'Europe/Madrid',
    })
    expect(await getPreferences(db, 'b@example.com')).toEqual({ ...PREFERENCES, clock: '12' })
    await setPreference(db, 'a@example.com', 'timeZone', undefined)
    expect((await getPreferences(db, 'a@example.com')).timeZone).toBeUndefined()
  })
})

describe('cron jobs', () => {
  it('take a period’s run once, whoever asks, and the next period’s again', async () => {
    const db = sqliteD1()
    const hour = Date.UTC(2026, 9, 28, 10)
    expect(await claimRun(db, 'escalation', hour, hour + 1)).toBe(true)
    expect(await claimRun(db, 'escalation', hour, hour + 60_000)).toBe(false)
    expect(await claimRun(db, 'retention', hour, hour + 1)).toBe(true)
    expect(await claimRun(db, 'escalation', hour + 3_600_000, hour + 3_600_000)).toBe(true)
  })
})
