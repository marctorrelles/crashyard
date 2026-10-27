// Start's own config: server functions only answer the dashboard's own pages (the session cookie rides along on a
// link from elsewhere, so a page elsewhere mustn't be able to call them).
import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

const serverFn = (request: Request) => new URL(request.url).pathname.startsWith('/_serverFn')

export const startInstance = createStart(() => ({
  requestMiddleware: [createCsrfMiddleware({ filter: ({ request }) => serverFn(request) })],
}))
