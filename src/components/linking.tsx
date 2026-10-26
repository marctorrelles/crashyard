// How an app links to a project, per platform: the SDK and its init with this project's DSN. docs/linking.md says the
// same; keep them in step.
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { Platform } from '@/data/projects'

const GUIDES: Record<Platform, { steps: string; code: (dsn: string) => string }[]> = {
  apple: [
    { steps: 'Add sentry-cocoa with Swift Package Manager: https://github.com/getsentry/sentry-cocoa', code: () => '' },
    {
      steps: 'Start it first thing, in your App’s init:',
      code: (dsn) => `import Sentry

SentrySDK.start { options in
    options.dsn = "${dsn}"
    #if DEBUG
    options.environment = "development"
    #endif
    options.sendDefaultPii = false
}`,
    },
  ],
  android: [
    {
      steps: 'Add the SDK to your app’s build.gradle.kts:',
      code: () => 'implementation("io.sentry:sentry-android:8.+")',
    },
    {
      steps: 'And the DSN to AndroidManifest.xml, inside <application>:',
      code: (dsn) => `<meta-data android:name="io.sentry.dsn" android:value="${dsn}" />
<meta-data android:name="io.sentry.send-default-pii" android:value="false" />`,
    },
  ],
  javascript: [
    { steps: 'Install the SDK:', code: () => 'pnpm add @sentry/browser' },
    {
      steps: 'Start it before your app renders:',
      code: (dsn) => `import * as Sentry from '@sentry/browser'

Sentry.init({
  dsn: '${dsn}',
  environment: import.meta.env.MODE,
  release: import.meta.env.VITE_RELEASE,
})`,
    },
  ],
  node: [
    { steps: 'Install the SDK:', code: () => 'pnpm add @sentry/node' },
    {
      steps: 'Start it before anything else runs:',
      code: (dsn) => `import * as Sentry from '@sentry/node'

Sentry.init({
  dsn: '${dsn}',
  environment: process.env.NODE_ENV ?? 'production',
})`,
    },
  ],
  other: [{ steps: 'Any Sentry SDK works: set its DSN to this one.', code: () => '' }],
}

export function Linking({
  platform,
  dsn,
  origin,
  id,
  publicKey,
}: {
  platform: Platform
  dsn: string
  origin: string
  id: number
  publicKey: string
}) {
  const test = `curl -X POST '${origin}/api/${id}/envelope/?sentry_key=${publicKey}' \\
  --data-binary $'{}\\n{"type":"event"}\\n{"message":"Hello from curl","level":"info"}\\n'`
  return (
    <ol className="grid gap-4">
      {GUIDES[platform].map((g, i) => (
        <li key={i} className="grid min-w-0 gap-2">
          <p className="text-sm">{g.steps}</p>
          {g.code(dsn) && <Code text={g.code(dsn)} />}
        </li>
      ))}
      <li className="grid min-w-0 gap-2">
        <p className="text-sm">Then check it arrives: this sends a test message, which shows up under Issues.</p>
        <Code text={test} />
      </li>
    </ol>
  )
}

export function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="relative min-w-0">
      <pre className="overflow-x-auto rounded-xl border bg-muted/40 p-3 pr-11 font-mono text-xs leading-5">{text}</pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </Button>
    </div>
  )
}
