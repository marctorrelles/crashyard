// A project's Debug files settings: how each SDK uploads its debug files or source maps with sentry-cli or a
// build plugin. The tokens they need are on Settings, Tokens.
import { Link } from '@tanstack/react-router'
import { Code, PlatformTabs } from '@/components/linking'

type Props = { slug: string; origin: string }

const STEPS: Record<string, (p: Props) => { text: string; code: string }[]> = {
  Apple: () => [
    {
      text: 'After archiving, upload the dSYMs. A Run Script build phase works too, with the debug information format set to DWARF with dSYM File.',
      code: 'sentry-cli debug-files upload --include-sources "$DWARF_DSYM_FOLDER_PATH"',
    },
  ],
  Android: ({ origin, slug }) => [
    {
      text: 'Add the Sentry Gradle plugin. It uploads the ProGuard mapping and NDK symbols on every release build.',
      code: 'plugins { id("io.sentry.android.gradle") version "5.+" }',
    },
    {
      text: 'Point it at crashyard in sentry.properties at the project root. Keep the token in SENTRY_AUTH_TOKEN, not in the file.',
      code: `defaults.url=${origin}/\ndefaults.org=crashyard\ndefaults.project=${slug}`,
    },
  ],
  Browser: ({ origin, slug }) => [
    {
      text: 'Build with source maps and let the Vite plugin upload them. It gives each file a debug ID.',
      code: 'pnpm add -D @sentry/vite-plugin',
    },
    {
      text: 'In vite.config.ts:',
      code: `import { sentryVitePlugin } from '@sentry/vite-plugin'

export default defineConfig({
  build: { sourcemap: true },
  plugins: [sentryVitePlugin({ url: '${origin}/', org: 'crashyard', project: '${slug}', authToken: process.env.SENTRY_AUTH_TOKEN })],
})`,
    },
  ],
  'Node.js': () => [
    {
      text: 'Give the built files debug IDs, then upload them with their source maps.',
      code: 'sentry-cli sourcemaps inject dist\nsentry-cli sourcemaps upload dist',
    },
  ],
  Other: () => [
    {
      text: 'Any sentry-cli upload command works.',
      code: 'sentry-cli debug-files upload path/to/symbols\nsentry-cli sourcemaps upload dist',
    },
  ],
}

export const size = (n: number) =>
  n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** The settings sentry-cli reads, then each SDK's steps */
export function UploadSteps({ slug, origin }: Props) {
  const env = `export SENTRY_URL=${origin}/\nexport SENTRY_ORG=crashyard\nexport SENTRY_PROJECT=${slug}\nexport SENTRY_AUTH_TOKEN=<a token>`
  return (
    <ol className="grid gap-4">
      <li className="grid min-w-0 gap-2">
        <p className="text-sm">
          sentry-cli and the build plugins read these to know where to upload. Create a token for this project in{' '}
          <Link to="/settings/tokens" className="font-medium underline underline-offset-2">
            Settings, Tokens
          </Link>
          .
        </p>
        <Code text={env} />
      </li>
      <li className="min-w-0">
        <PlatformTabs
          tabs={STEPS}
          render={(steps) => (
            <ol className="grid gap-4">
              {steps({ origin, slug }).map((s, i) => (
                <li key={i} className="grid min-w-0 gap-2">
                  <p className="text-sm">{s.text}</p>
                  <Code text={s.code} />
                </li>
              ))}
            </ol>
          )}
        />
      </li>
    </ol>
  )
}
