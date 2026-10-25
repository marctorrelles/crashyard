// Start's own config: server functions only answer the dashboard's own pages (Access's cookie rides along on any
// request to the domain, so a page elsewhere mustn't be able to call them).
import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

export const startInstance = createStart(() => ({
  requestMiddleware: [
    createCsrfMiddleware({ filter: ({ request }) => new URL(request.url).pathname.startsWith('/_serverFn') }),
  ],
}))
