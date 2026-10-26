// The logs page's search as a file, CSV or JSON Lines, the newest 10,000 at most, for whoever is signed in.
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { exportLogs, FORMATS, type Format } from '@/data/export'
import { MAX_SPAN, RANGES, type Range, type Window } from '@/data/logs'
import { projectBySlug } from '@/data/projects'

export const Route = createFileRoute('/logs_/export')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!request.headers.get('x-crashyard-viewer')) return new Response('Sign in to export logs.', { status: 403 })
        const url = new URL(request.url)
        const get = (k: string) => url.searchParams.get(k) ?? undefined
        const format = (get('format') ?? 'csv') as Format
        if (!Object.hasOwn(FORMATS, format)) return new Response('Export as csv or jsonl.', { status: 400 })
        const query = (get('query') ?? '').slice(0, 1000)
        const from = Number(get('from'))
        const to = Number(get('to'))
        const range = get('range') ?? '24h'
        const window: Window =
          Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && from < to && to - from <= MAX_SPAN
            ? { from, to }
            : { range: Object.hasOwn(RANGES, range) ? (range as Range) : '24h' }
        const slug = get('project')
        const projectId = slug ? ((await projectBySlug(env.DB, slug))?.id ?? -1) : undefined
        const now = Date.now()
        let body: string
        try {
          body = await exportLogs(env.DB, { query, projectId, window }, format, now)
        } catch (error) {
          return new Response(error instanceof Error ? error.message : 'This search can’t be exported.', {
            status: 400,
          })
        }
        const name = `logs-${new Date(now).toISOString().slice(0, 19).replaceAll(':', '-')}.${format}`
        return new Response(body, {
          headers: {
            'Content-Type': FORMATS[format],
            'Content-Disposition': `attachment; filename="${name}"`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'Cache-Control': 'private, no-store',
          },
        })
      },
    },
  },
})
