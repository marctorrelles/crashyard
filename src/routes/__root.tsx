import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { Layout } from '@/components/shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getSidebar } from '@/fns'
import favicon from '../favicon.svg?url'
import appCss from '../styles.css?url'

// Light or dark follows the system, set before paint so nothing flashes, and again when the system changes
const THEME_SCRIPT = `(function(){var m=window.matchMedia('(prefers-color-scheme: dark)');function s(){document.documentElement.classList.toggle('dark',m.matches);document.documentElement.style.colorScheme=m.matches?'dark':'light'}s();m.addEventListener('change',s)})()`

export const Route = createRootRoute({
  // The sidebar: the projects, the one picked last, folded or not
  loader: () => getSidebar(),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { title: 'crashyard' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: favicon },
    ],
  }),
  shellComponent: RootDocument,
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
  errorComponent: ({ error }) => (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-1 text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
      <p className="mt-3 text-sm">
        Reload the page to try again, or{' '}
        <a href="/" className="font-medium underline underline-offset-2">
          go back to the overview
        </a>
        .
      </p>
      {import.meta.env.DEV && error instanceof Error && <pre className="mt-4 overflow-auto text-xs">{error.stack}</pre>}
    </main>
  ),
  notFoundComponent: () => (
    <main className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-1 text-muted-foreground">
        This page doesn’t exist, or it moved without leaving a forwarding address.{' '}
        <a href="/" className="font-medium text-foreground underline underline-offset-2">
          Back to the overview
        </a>
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
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
        <Scripts />
      </body>
    </html>
  )
}
