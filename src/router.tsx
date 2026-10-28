import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // A page opened with other params is a new page: the issue, dashboard or project switched to never shows, nor
    // saves, what was typed or picked on the one before (Start keeps a route's component mounted otherwise)
    defaultRemountDeps: ({ params }) => params,
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
