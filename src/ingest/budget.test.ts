import { describe, expect, it } from 'vitest'
import { eventJson, trimEvent } from './budget'
import { type Frame, normalizeEvent } from './event'

const frames = (n: number, name = 'f'): Frame[] =>
  Array.from({ length: n }, (_, i) => ({
    function: `${name}${i}`,
    filename: `src/${name}${i}.swift`,
    lineno: i,
    inApp: true,
  }))

describe('the event size budget', () => {
  it('trims a huge event under 900 KB, keeping the newest breadcrumbs, the crash and the crashed thread', async () => {
    const event = await normalizeEvent({ message: 'big' })
    event.breadcrumbs = Array.from({ length: 10_000 }, (_, i) => ({ message: `crumb ${i}`, timestamp: i }))
    event.exceptions = [{ type: 'Crash', value: 'boom', frames: frames(5000) }]
    event.contexts = { app: { log: 'x'.repeat(2_000_000) } }
    event.threads = Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      crashed: i === 150,
      frames: frames(150, `t${i}_`),
    }))

    const trimmed = trimEvent(event)
    expect(new TextEncoder().encode(JSON.stringify(trimmed)).length).toBeLessThan(900_000)
    expect(trimmed.breadcrumbs).toHaveLength(100)
    expect(trimmed.breadcrumbs.at(-1)!.message).toBe('crumb 9999')
    const stack = trimmed.exceptions[0].frames
    expect(stack.at(-1)!.function).toBe('f4999') // the crashing frame, and those nearest it
    expect(stack.at(0)!.function).toBe(`f${5000 - stack.length}`)
    expect(trimmed.threads![0]).toMatchObject({ id: '150', crashed: true })
    expect(trimmed._trimmed).toEqual(expect.arrayContaining(['breadcrumbs', 'threads', 'frames', 'contexts']))
    expect(event.breadcrumbs).toHaveLength(10_000) // a copy: what's passed in is left as it was
  })

  it('leaves an event under the budget as it is', async () => {
    const event = await normalizeEvent({ message: 'small', breadcrumbs: [{ message: 'a' }] })
    expect(trimEvent(event)).toBe(event)
    expect(eventJson(event)).toBe(JSON.stringify(event))
  })
})
