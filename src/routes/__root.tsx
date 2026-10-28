import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import { Layout } from '@/components/shell'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getSidebar } from '@/fns'
import favicon from '../favicon.svg?url'
import appCss from '../styles.css?url'

// Before paint, so nothing flashes: light or dark as the viewer chose (the `theme` cookie, Settings, Appearance), else
// as the system is, and again when it changes; the theme's look from the `style` cookie, on <html data-style>. It also keeps the browser's time zone in the `tz` cookie, so the server
// writes times in it (src/components/time.tsx)
const THEME_SCRIPT = `(function(){var d=document.documentElement,c=document.cookie.match(/(?:^|; )theme=(light|dark)/),m=window.matchMedia('(prefers-color-scheme: dark)'),y=document.cookie.match(/(?:^|; )style=([a-z]+)/);if(y)d.dataset.style=y[1];function s(){var k=c?c[1]==='dark':m.matches;d.classList.toggle('dark',k);d.style.colorScheme=k?'dark':'light'}s();m.addEventListener('change',s);try{var z=Intl.DateTimeFormat().resolvedOptions().timeZone;if(z&&document.cookie.indexOf('tz='+encodeURIComponent(z))<0)document.cookie='tz='+encodeURIComponent(z)+'; path=/; max-age=31536000; samesite=lax'}catch(e){}})()`

export const Route = createRootRoute({
  // The sidebar: the projects, the one picked last, folded or not; the viewer's preferences and time zone
  loader: () => getSidebar(),
  // The dashboard installs as an app (public/manifest.webmanifest); a status page doesn't offer to, it's the public's
  head: ({ matches }) => {
    const app = !matches.some((m) => m.pathname.startsWith('/status/'))
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#F2F3F6' },
        { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#0D1013' },
        { title: 'crashyard' },
      ],
      links: [
        { rel: 'stylesheet', href: appCss },
        { rel: 'icon', type: 'image/svg+xml', href: favicon },
        ...(app
          ? [
              { rel: 'manifest', href: '/manifest.webmanifest' },
              { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
            ]
          : []),
      ],
    }
  },
  shellComponent: RootDocument,
  // Signed out, only the sign-in pages and status pages open (src/server.ts), on their own without the sidebar; a
  // status page has none for anyone, as the public sees it
  component: function Root() {
    const { viewer } = Route.useLoaderData()
    const status = useRouterState({ select: (s) => s.location.pathname.startsWith('/status/') })
    return viewer && !status ? (
      <Layout>
        <Outlet />
      </Layout>
    ) : (
      <Outlet />
    )
  },
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
