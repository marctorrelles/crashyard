import { createFileRoute, Link } from '@tanstack/react-router'
import { IconChevronRight } from '@tabler/icons-react'
import { PageHeader, Shell } from '@/components/shell'
import { getStatusPages } from '@/fns'

export const Route = createFileRoute('/monitors/status-pages/')({
  loader: () => getStatusPages(),
  head: () => ({ meta: [{ title: 'Status pages · crashyard' }] }),
  component: StatusPages,
})

// Each project's public status page: where it is, and what's on it
function StatusPages() {
  const pages = Route.useLoaderData()
  return (
    <Shell crumbs={[<Link to="/monitors">Monitors</Link>, 'Status pages']}>
      <PageHeader title="Status pages">
        Each project has a public page with the uptime checks you choose and the incidents and maintenance you post.
      </PageHeader>
      <ul className="divide-y rounded-xl border">
        {pages.map((p) => (
          <li key={p.slug}>
            <Link
              to="/monitors/status-pages/$slug"
              params={{ slug: p.slug }}
              className="flex min-h-12 items-center gap-3 px-4 py-3 hover:bg-muted/40"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.status_domain ?? `/status/${p.slug}`} ·{' '}
                  {p.shown || p.open
                    ? [
                        p.shown && `${p.shown} check${p.shown === 1 ? '' : 's'} shown`,
                        p.open && `${p.open} open post${p.open === 1 ? '' : 's'}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : 'Not public yet'}
                </p>
              </div>
              <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
    </Shell>
  )
}
