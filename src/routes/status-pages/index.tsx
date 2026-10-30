import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { IconChevronRight } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader, Shell } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createStatusPage, getStatusPages } from '@/fns'

export const Route = createFileRoute('/status-pages/')({
  loader: () => getStatusPages(),
  head: () => ({ meta: [{ title: 'Status pages · crashyard' }] }),
  component: StatusPages,
})

// The public status pages: where each is and what's on it, and making a new one
function StatusPages() {
  const pages = Route.useLoaderData()
  return (
    <Shell crumbs={['Status pages']}>
      <PageHeader title="Status pages">
        Public pages with the uptime checks you choose, from any of your projects, and the incidents and maintenance you
        post.
      </PageHeader>
      <div className="grid gap-4">
        <NewPage />
        {pages.length ? (
          <ul className="divide-y rounded-xl border">
            {pages.map((p) => (
              <li key={p.id}>
                <Link
                  to="/status-pages/$slug"
                  params={{ slug: p.slug }}
                  className="flex min-h-12 items-center gap-3 px-4 py-3 hover:bg-muted/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.domain ?? `/status/${p.slug}`} ·{' '}
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
        ) : (
          <div className="grid gap-1 rounded-xl border border-dashed px-4 py-8 text-center">
            <p className="font-medium">No status pages yet</p>
            <p className="text-sm text-muted-foreground">
              Create one above, then choose the checks it shows. It goes public once it shows a check or a post.
            </p>
          </div>
        )}
      </div>
    </Shell>
  )
}

function NewPage() {
  const navigate = useNavigate()
  const [saving, setSaving] = useState(false)
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const name = new FormData(e.currentTarget).get('name')
        setSaving(true)
        try {
          const slug = await createStatusPage({ data: { name } })
          toast.success('Status page created')
          await navigate({ to: '/status-pages/$slug', params: { slug } })
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'The page couldn’t be created. Try again.')
        } finally {
          setSaving(false)
        }
      }}
    >
      <Input
        name="name"
        required
        maxLength={80}
        placeholder="All services"
        aria-label="Name of the new status page"
        className="min-w-0 flex-1 basis-56 max-sm:h-10 sm:max-w-sm"
      />
      <Button type="submit" disabled={saving} className="max-sm:h-10">
        Create status page
      </Button>
    </form>
  )
}
