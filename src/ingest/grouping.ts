// Which issue an event belongs to: a hash of what stays the same each time the same thing goes wrong.
//
// - An exception with a stack: its type and the five frames nearest the crash in the app's own code (all frames when
//   the SDK marks none as the app's). A frame is its function, or for native code without symbols the image and the
//   offset in it, which is the same on every run of a build (the image's address isn't, under ASLR).
// - An exception without a stack: its type and value. A message: the message.
// - A frame with no name (`?`, `<anonymous>`) is its line of source, or its file and line. A synthetic exception (one an
//   SDK made to carry a stack, as captureMessage does) groups without its type.
// - Values and messages are compared with numbers, ids, hex, UUIDs and quoted text masked, so "id 42" and "id 43" are
//   one issue.
// - An SDK's own fingerprint wins; "{{ default }}" in it stands for the default above.
import type { Frame, NormalizedEvent } from './event'

const FRAMES = 5

export function mask(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<string>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
}

function hexOffset(instruction?: string, image?: string): string | undefined {
  if (!instruction || !image) return undefined
  try {
    return `0x${(BigInt(instruction) - BigInt(image)).toString(16)}`
  } catch {
    return undefined
  }
}

// Names engines give functions that have none: grouping by them would make every anonymous frame the same
const ANONYMOUS = new Set(['?', '<anonymous>', 'anonymous', '<unknown>', 'Object.<anonymous>'])

export function frameKey(frame: Frame): string {
  if (frame.function && !ANONYMOUS.has(frame.function)) return [frame.module, frame.function].filter(Boolean).join('.')
  // An anonymous function: its line of source if the SDK sent it, as Sentry groups them
  if (frame.context?.line?.trim())
    return `${frame.module ?? frame.filename ?? ''}:${frame.context.line.trim().slice(0, 120)}`
  const offset = hexOffset(frame.instructionAddr, frame.imageAddr)
  const image = frame.package?.split('/').at(-1)
  if (image && offset) return `${image}+${offset}`
  return [frame.filename ?? frame.absPath, frame.lineno].filter(Boolean).join(':') || frame.instructionAddr || '?'
}

export function defaultComponents(event: NormalizedEvent): string[] {
  const main = event.exceptions.at(-1)
  if (main) {
    const inApp = main.frames.filter((f) => f.inApp)
    const frames = (inApp.length ? inApp : main.frames).slice(-FRAMES)
    // A synthetic exception's type is the SDK's, not the app's: leave it out
    if (frames.length) return [...(main.synthetic ? [] : [main.type]), ...frames.map(frameKey)]
    return [main.type, mask(main.value)]
  }
  return [mask(event.message || event.title)]
}

export async function fingerprintOf(event: NormalizedEvent): Promise<string> {
  const custom = event.fingerprint?.length ? event.fingerprint : undefined
  const components = custom
    ? custom.flatMap((part) => (/^\{\{\s*default\s*\}\}$/.test(part) ? defaultComponents(event) : [part]))
    : defaultComponents(event)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(components.join('\n')))
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}
