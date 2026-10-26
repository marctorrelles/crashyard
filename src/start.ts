// Start's own config: server functions only answer the dashboard's own pages (Access's cookie rides along on any
// request to the domain, so a page elsewhere mustn't be able to call them), and agents, signed in with an Access
// service token, only read through them: they change issues through MCP, when the deployment lets them.
import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'

const serverFn = (request: Request) => new URL(request.url).pathname.startsWith('/_serverFn')

const agentsRead = createMiddleware().server(({ request, next }) =>
  serverFn(request) && request.method !== 'GET' && request.headers.get('x-crashyard-viewer')?.startsWith('service:')
    ? new Response('Agents can read the dashboard but not change it.', { status: 403 })
    : next(),
)

export const startInstance = createStart(() => ({
  requestMiddleware: [createCsrfMiddleware({ filter: ({ request }) => serverFn(request) }), agentsRead],
}))
