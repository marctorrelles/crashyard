// An event's attachment, from R2, for whoever is signed in. Only images are shown in the page; anything else, SVG and
// HTML included, downloads. Nothing served here can run: no sniffing, and a sandbox with nothing allowed.
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { attachmentType } from '@/data/issues'

export const Route = createFileRoute('/attachments/$id')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!request.headers.get('x-crashyard-viewer'))
          return new Response('Sign in to open attachments.', { status: 403 })
        const id = Number(params.id)
        const row = Number.isInteger(id)
          ? await env.DB.prepare('SELECT filename, content_type, r2_key FROM attachments WHERE id = ?')
              .bind(id)
              .first<{ filename: string; content_type: string | null; r2_key: string }>()
          : null
        const object = row && (await env.FILES.get(row.r2_key))
        if (!row || !object) return new Response('This attachment is no longer stored.', { status: 404 })
        const image = attachmentType(row.filename, row.content_type)
        return new Response(object.body, {
          headers: {
            'Content-Type': image ?? 'application/octet-stream',
            'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename="${row.filename.replace(/[^\w.-]/g, '_')}"`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'Cache-Control': 'private, max-age=3600',
          },
        })
      },
    },
  },
})
