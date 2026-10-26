import { describe, expect, it } from 'vitest'
import { attachmentType } from './issues'

describe('attachments', () => {
  it('shows png, jpeg, gif and webp as images, and nothing else', () => {
    expect(attachmentType('screenshot.png', 'image/png')).toBe('image/png')
    expect(attachmentType('photo.JPG', null)).toBe('image/jpeg')
    expect(attachmentType('a.bin', 'image/webp')).toBe('image/webp')
    for (const [name, type] of [
      ['logo.svg', 'image/svg+xml'],
      ['page.html', 'text/html'],
      ['view-hierarchy.json', 'application/json'],
      ['trick.svg', 'image/png;x'],
    ])
      expect(attachmentType(name, type), name).toBeNull()
  })
})
