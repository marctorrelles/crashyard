// Start's own config: server functions only answer the dashboard's own pages (the session cookie rides along on a
// link from elsewhere, so a page elsewhere mustn't be able to call them). Chosen by Start's own handler type, not
// the path: Start decodes a path before deciding, so `/%5FserverFn/…` is a server function too.
import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

export const startInstance = createStart(() => ({
  requestMiddleware: [createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })],
}))
