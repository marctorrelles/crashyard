// How an app links to a project, per SDK: the SDK and its init with this project's DSN. docs/linking.md says the
// same; keep them in step.
import { IconCheck, IconCopy } from '@tabler/icons-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Step = { steps: string; code: (dsn: string) => string }

const GUIDES: Record<string, Step[]> = {
  Apple: [
    {
      steps: 'Add sentry-cocoa with Swift Package Manager from https://github.com/getsentry/sentry-cocoa.',
      code: () => '',
    },
    {
      steps: 'Start it first, in your app’s initializer:',
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
  Android: [
    {
      steps: 'Add the SDK to your app’s build.gradle.kts:',
      code: () => 'implementation("io.sentry:sentry-android:8.+")',
    },
    {
      steps: 'Then add the DSN to AndroidManifest.xml, inside <application>:',
      code: (dsn) => `<meta-data android:name="io.sentry.dsn" android:value="${dsn}" />
<meta-data android:name="io.sentry.send-default-pii" android:value="false" />`,
    },
  ],
  Browser: [
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
  'Node.js': [
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
  'Cloudflare Workers': [
    { steps: 'Install the SDK:', code: () => 'pnpm add @sentry/cloudflare' },
    {
      steps: 'Wrap the Worker’s handler. The Worker needs the nodejs_als or nodejs_compat compatibility flag.',
      code: (dsn) => `import * as Sentry from '@sentry/cloudflare'

export default Sentry.withSentry(
  () => ({ dsn: '${dsn}', sendDefaultPii: false }),
  { async fetch(request, env, ctx) { /* … */ } },
)`,
    },
  ],
  'React Native': [
    { steps: 'Install the SDK:', code: () => 'pnpm add @sentry/react-native' },
    {
      steps: 'Start it in your app’s entry file, and wrap the root component:',
      code: (dsn) => `import * as Sentry from '@sentry/react-native'

Sentry.init({ dsn: '${dsn}', sendDefaultPii: false })

export default Sentry.wrap(App)`,
    },
  ],
  Flutter: [
    { steps: 'Add the SDK:', code: () => 'flutter pub add sentry_flutter' },
    {
      steps: 'Start it in main(), running your app inside it:',
      code: (dsn) => `import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  await SentryFlutter.init(
    (options) => options.dsn = '${dsn}',
    appRunner: () => runApp(const MyApp()),
  );
}`,
    },
  ],
  Other: [
    {
      steps: 'Any Sentry SDK works, such as Python, Go, Ruby, PHP, Java or .NET: set its DSN to this one.',
      code: () => '',
    },
  ],
}

export function Linking({
  dsn,
  origin,
  id,
  publicKey,
}: {
  dsn: string
  origin: string
  id: number
  publicKey: string
}) {
  const test = `curl -X POST '${origin}/api/${id}/envelope/?sentry_key=${publicKey}' \\
  --data-binary $'{}\\n{"type":"event"}\\n{"message":"Hello from curl","level":"info"}\\n'`
  return (
    <div className="grid gap-4">
      <PlatformTabs
        tabs={GUIDES}
        render={(steps) => (
          <ol className="grid gap-4">
            {steps.map((g, i) => (
              <li key={i} className="grid min-w-0 gap-2">
                <p className="text-sm">{g.steps}</p>
                {g.code(dsn) && <Code text={g.code(dsn)} />}
              </li>
            ))}
          </ol>
        )}
      />
      <div className="grid min-w-0 gap-2">
        <p className="text-sm">To check the connection, send a test message. It appears under Issues.</p>
        <Code text={test} />
      </div>
    </div>
  )
}

/** One tab per SDK, by name; the row scrolls sideways on a phone */
export function PlatformTabs<T>({ tabs, render }: { tabs: Record<string, T>; render: (tab: T) => React.ReactNode }) {
  const names = Object.keys(tabs)
  return (
    <Tabs defaultValue={names[0]} className="min-w-0">
      <TabsList variant="line" className="max-w-full justify-start overflow-x-auto">
        {names.map((n) => (
          <TabsTrigger key={n} value={n} className="flex-none">
            {n}
          </TabsTrigger>
        ))}
      </TabsList>
      {names.map((n) => (
        <TabsContent key={n} value={n} className="pt-2">
          {render(tabs[n])}
        </TabsContent>
      ))}
    </Tabs>
  )
}

export function Code({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    // The button has its own column, so long text scrolls beside it and never under it
    <div className="flex min-w-0 items-start rounded-xl border bg-muted/40">
      <pre className="min-w-0 flex-1 overflow-x-auto p-3 pr-1 font-mono text-xs leading-5">{text}</pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="m-1.5 shrink-0"
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
