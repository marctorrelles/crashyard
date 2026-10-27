import { describe, expect, it } from 'vitest'
import { sqliteD1 } from '../../test/fakes'
import { planOf, probePlan } from './plan'

// D1 as Workers Free answers it: the 51st call of a request fails
function limited(limit: number, message = 'Too many API requests by single worker invocation.') {
  let calls = 0
  return {
    prepare: () => ({ first: async () => (++calls > limit ? Promise.reject(new Error(message)) : { 1: 1 }) }),
  } as unknown as D1Database
}

describe('probePlan', () => {
  it('reads Workers Free from the subrequest limit, and anything else as no answer', async () => {
    expect(await probePlan(limited(50))).toBe(false)
    expect(await probePlan(limited(10_000))).toBe(true)
    await expect(probePlan(limited(3, 'D1 is down'))).rejects.toThrow('D1 is down')
  })
})

describe('planOf', () => {
  it('keeps the plan a day, and checks again when asked', async () => {
    const db = sqliteD1()
    expect(await planOf(db, 1000)).toEqual({ paid: true, checked: 1000 })
    expect(await planOf(db, 2000)).toEqual({ paid: true, checked: 1000 })
    expect(await planOf(db, 2000, true)).toEqual({ paid: true, checked: 2000 })
    expect(await planOf(db, 2000 + 86_400_000)).toEqual({ paid: true, checked: 2000 + 86_400_000 })
  })
})
