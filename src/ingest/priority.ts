// An issue's priority: high, medium or low, given by its level when it's made, then changed by hand.

export const PRIORITIES = ['high', 'medium', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]
/** A new issue's priority by its level, unless the project says otherwise (Settings, the project's Issues) */
export const PRIORITY_BY_LEVEL: Record<string, Priority> = {
  fatal: 'high',
  error: 'medium',
  warning: 'low',
  info: 'low',
  debug: 'low',
}

/** The priority a project gives a new issue of this level */
export function priorityFor(priorities: string | null | undefined, level: string): Priority {
  let chosen: unknown
  try {
    chosen = priorities ? (JSON.parse(priorities) as Record<string, unknown>)[level] : undefined
  } catch {
    chosen = undefined
  }
  return PRIORITIES.includes(chosen as Priority) ? (chosen as Priority) : (PRIORITY_BY_LEVEL[level] ?? 'low')
}
