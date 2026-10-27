// Which Cloudflare Workers plan the account is on, found without an API token: Workers Free allows 50 subrequests an
// invocation, D1 queries among them, and Workers Paid 10,000. One request making 55 `SELECT 1` queries (no rows read)
// gets "Too many …" past the 50th only on Free. Kept a day in the `cloudflare.plan` setting.
import { getSetting, setSetting } from './settings'

export const PLAN_KEY = 'cloudflare.plan'
export type Plan = { paid: boolean; checked: number }
const DAY = 86_400_000
const PROBES = 55

export async function probePlan(db: D1Database): Promise<boolean> {
  const results = await Promise.allSettled(Array.from({ length: PROBES }, () => db.prepare('SELECT 1').first()))
  const failed = results
    .filter((r) => r.status === 'rejected')
    .map((r) => String((r.reason as Error)?.message ?? r.reason))
  if (failed.some((m) => /too many/i.test(m))) return false
  // Any other failure says nothing of the plan
  if (failed.length) throw new Error(failed[0])
  return true
}

/** The plan as last found, checked again when older than a day or when asked */
export async function planOf(db: D1Database, now: number, fresh = false): Promise<Plan | null> {
  const known = await getSetting<Plan | null>(db, PLAN_KEY, null)
  if (known && !fresh && now - known.checked < DAY) return known
  try {
    const plan = { paid: await probePlan(db), checked: now }
    await setSetting(db, PLAN_KEY, plan, null, now)
    return plan
  } catch (e) {
    console.error('checking the Workers plan failed', e)
    return known
  }
}
