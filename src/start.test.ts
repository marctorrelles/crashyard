import { expect, it } from 'vitest'
import { agentRefused } from './start'

it('refuses an agent a server function that changes anything', () => {
  const call = (method: string, viewer: string) =>
    agentRefused(
      new Request('https://x/_serverFn/abc', {
        method,
        headers: { 'x-crashyard-viewer': viewer },
      }),
    )
  expect(call('POST', 'service:bot')).toBe(true)
  expect(call('GET', 'service:bot')).toBe(false)
  expect(call('POST', 'me@example.org')).toBe(false)
  expect(
    agentRefused(new Request('https://x/issues', { method: 'POST', headers: { 'x-crashyard-viewer': 'service:bot' } })),
  ).toBe(false)
})
