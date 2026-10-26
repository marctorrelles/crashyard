// "Readable stacks" on a project's settings: auth tokens for sentry-cli and the build plugins, how each platform
// uploads its debug files or source maps, and what's been uploaded.
import { useRouter } from '@tanstack/react-router'
import { IconKey, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Ago } from '@/components/bits'
import { Code } from '@/components/linking'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Platform } from '@/data/projects'
import { createToken, revokeToken } from '@/fns'

type Props = {
  slug: string
  platform: Platform
  origin: string
  tokens: { id: number; name: string; created_by: string; created_at: number; last_used_at: number | null }[]
  uploads: {
    debugFiles: {
      debug_id: string
      kind: string
      arch: string | null
      name: string
      size: number
      created_at: number
    }[]
    bundles: { checksum: string; release: string | null; size: number; created_at: number; files: number }[]
  }
  now: number
}

const STEPS: Record<Platform, (p: { origin: string; slug: string }) => { text: string; code: string }[]> = {
  apple: () => [
    {
      text: 'After archiving, upload the dSYMs. A Run Script build phase works too, with the debug information format set to DWARF with dSYM File.',
      code: 'sentry-cli debug-files upload --include-sources "$DWARF_DSYM_FOLDER_PATH"',
    },
  ],
  android: ({ origin, slug }) => [
    {
      text: 'Add the Sentry Gradle plugin. It uploads the ProGuard mapping and NDK symbols on every release build.',
      code: 'plugins { id("io.sentry.android.gradle") version "5.+" }',
    },
    {
      text: 'Point it at crashyard in sentry.properties at the project root. Keep the token in SENTRY_AUTH_TOKEN, not in the file.',
      code: `defaults.url=${origin}/\ndefaults.org=crashyard\ndefaults.project=${slug}`,
    },
  ],
  javascript: ({ origin, slug }) => [
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
  node: () => [
    {
      text: 'Give the built files debug IDs, then upload them with their source maps.',
      code: 'sentry-cli sourcemaps inject dist\nsentry-cli sourcemaps upload dist',
    },
  ],
  other: () => [
    {
      text: 'Any sentry-cli upload command works.',
      code: 'sentry-cli debug-files upload path/to/symbols\nsentry-cli sourcemaps upload dist',
    },
  ],
}

const size = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function Uploads({ slug, platform, origin, tokens, uploads, now }: Props) {
  const router = useRouter()
  const [made, setMade] = useState<string>()
  const [name, setName] = useState('')
  const env = `export SENTRY_URL=${origin}/\nexport SENTRY_ORG=crashyard\nexport SENTRY_PROJECT=${slug}\nexport SENTRY_AUTH_TOKEN=${made ?? '<a token from below>'}`
  return (
    <div className="grid gap-5">
      <ol className="grid gap-4">
        <li className="grid min-w-0 gap-2">
          <p className="text-sm">sentry-cli and the build plugins read these to know where to upload.</p>
          <Code text={env} />
        </li>
        {STEPS[platform]({ origin, slug }).map((s, i) => (
          <li key={i} className="grid min-w-0 gap-2">
            <p className="text-sm">{s.text}</p>
            <Code text={s.code} />
          </li>
        ))}
      </ol>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">Auth tokens</h3>
        <p className="text-xs text-muted-foreground">
          Tokens can upload files and create releases in every project, and nothing else.
        </p>
        {made && (
          <div className="grid gap-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm">Copy the token now. It won’t be shown again.</p>
            <Code text={made} />
          </div>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              setMade(await createToken({ data: { name } }))
              setName('')
              await router.invalidate()
            } catch {
              toast.error('The token couldn’t be created')
            }
          }}
        >
          <Input
            className="max-w-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name it, for example Xcode or CI"
            aria-label="Token name"
          />
          <Button type="submit" variant="outline">
            <IconKey data-icon="inline-start" />
            Create token
          </Button>
        </form>
        {tokens.length > 0 && (
          <ul className="divide-y rounded-xl border text-sm">
            {tokens.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{t.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t.created_by} · created <Ago at={t.created_at} now={now} />
                    {t.last_used_at ? (
                      <>
                        {' '}
                        · used <Ago at={t.last_used_at} now={now} />
                      </>
                    ) : (
                      ' · never used'
                    )}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Revoke ${t.name}`}
                  onClick={async () => {
                    if (!confirm(`Revoke ${t.name}? Uploads using it will stop working.`)) return
                    await revokeToken({ data: { id: t.id } })
                    await router.invalidate()
                  }}
                >
                  <IconTrash />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(uploads.debugFiles.length > 0 || uploads.bundles.length > 0) && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Uploaded files</h3>
          <ul className="divide-y rounded-xl border text-xs">
            {uploads.debugFiles.map((f) => (
              <li
                key={`${f.debug_id}${f.created_at}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2"
              >
                <span className="font-medium">
                  {f.kind === 'proguard' ? 'ProGuard mapping' : `${f.kind} ${f.arch ?? ''}`}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{f.debug_id}</span>
                <span className="text-muted-foreground">
                  {size(f.size)} · <Ago at={f.created_at} now={now} />
                </span>
              </li>
            ))}
            {uploads.bundles.map((b) => (
              <li key={b.checksum} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                <span className="font-medium">Source maps</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {b.files} file{b.files === 1 ? '' : 's'}
                  {b.release && ` · ${b.release}`}
                </span>
                <span className="text-muted-foreground">
                  {size(b.size)} · <Ago at={b.created_at} now={now} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
