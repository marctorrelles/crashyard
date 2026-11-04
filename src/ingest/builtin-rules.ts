// The stack trace rules grouping v2 applies before a project's own: Sentry's built-in rules, then crashyard's.
//
// `sentry-rules.txt` is `src/sentry/grouping/enhancer/enhancement-configs/newstyle@2023-01-11.txt` of getsentry/sentry
// 24.10.0, unchanged: Apache-2.0 since 2026-10-15 under its FSL-1.1-Apache-2.0 license, copyright Functional Software,
// Inc. dba Sentry. Its rules need trimmed function names (`functions.ts`), categories and sibling matchers (`rules.ts`).
import { parseGroupingRules, type Rules } from './rules'
import sentry from './sentry-rules.txt?raw'

const CRASHYARD = String.raw`
# An Apple app's main and Swift's @main start its main thread. Sentry reaches them through UIApplicationMain and the
# like, threadbase in its rules, but crashyard has no symbols for Apple's frameworks, so it names the app's own. A C or
# C++ program's main still groups, as in Sentry
family:native package:**.app/** function:main                     category=threadbase
family:native package:**.app/** function:*.$main                  category=threadbase

# Sentry takes an unnamed libsystem_pthread frame for a thread's start and leaves out every frame below it. Sentry names
# Apple's frames, so one it can't is rare; crashyard names none, so a wait in pthread_cond_wait would hide the app's
# frames that called it. It's a system frame like any other here
family:native package:/usr/lib/system/libsystem_pthread.dylib function:"<unknown>" category=system

# The Sentry SDK's Swift types, linked into the app as Swift Package Manager does: Sentry's rules name only its
# Objective-C methods. A project with types of its own named Sentry… overrides it: function:Sentry* +app +group
family:native function:Sentry*                                    -app -group
`

function parse(text: string): Rules {
  const rules = parseGroupingRules(text, { escapes: true })
  if ('error' in rules) throw new Error(`built-in grouping rules, line ${rules.line}: ${rules.error}`)
  return rules
}

/** Sentry's built-in stack trace rules, then crashyard's */
export const BUILTIN_RULES: Rules = parse(`${sentry}\n${CRASHYARD}`)

/**
 * Sentry's built-in fingerprints (`src/sentry/grouping/fingerprinting/configs/javascript@2024-02-02` of 24.10.0, the
 * same license): every ChunkLoadError is one issue, and React's hydration errors one a transaction. A project's
 * fingerprint rules come first
 */
export const BUILTIN_FINGERPRINTS: Rules = parse(String.raw`
family:javascript error.type:"ChunkLoadError" -> chunkloaderror
family:javascript error.value:"ChunkLoadError*" -> chunkloaderror
family:javascript tags.transaction:"*" message:"Hydration failed because the initial UI does not match what was rendered on the server." -> hydrationerror, {{tags.transaction}}
family:javascript tags.transaction:"*" message:"The server could not finish this Suspense boundary, likely due to an error during server rendering. Switched to client rendering." -> hydrationerror, {{tags.transaction}}
family:javascript tags.transaction:"*" message:"There was an error while hydrating this Suspense boundary. Switched to client rendering." -> hydrationerror, {{tags.transaction}}
family:javascript tags.transaction:"*" message:"There was an error while hydrating. Because the error happened outside of a Suspense boundary, the entire root will switch to client rendering." -> hydrationerror, {{tags.transaction}}
family:javascript tags.transaction:"*" message:"Text content does not match server-rendered HTML." -> hydrationerror, {{tags.transaction}}
`)
