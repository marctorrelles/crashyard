import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { Toaster } from '@/components/ui/sonner'
import appCss from '../styles.css?url'

// Light or dark follows the system, set before paint so nothing flashes, and again when the system changes
const THEME_SCRIPT = `(function(){var m=window.matchMedia('(prefers-color-scheme: dark)');function s(){document.documentElement.classList.toggle('dark',m.matches);document.documentElement.style.colorScheme=m.matches?'dark':'light'}s();m.addEventListener('change',s)})()`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'crashyard' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  errorComponent: ({ error }) => (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Something broke</h1>
      <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
      {import.meta.env.DEV && error instanceof Error && <pre className="mt-4 overflow-auto text-xs">{error.stack}</pre>}
    </main>
  ),
  notFoundComponent: () => (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Not here</h1>
      <p className="mt-1 text-muted-foreground">
        Nothing lives at this address.{' '}
        <a href="/" className="underline">
          Go home
        </a>
        .
      </p>
    </main>
  ),
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="min-h-dvh font-sans antialiased">
        {children}
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}
