import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { count } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { SettingsCard } from '@/components/settings'
import { useProjects } from '@/components/shell'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getUsage } from '@/fns'

export const Route = createFileRoute('/settings/usage')({
  validateSearch: (s: Record<string, unknown>): { project?: string } => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: ({ deps }) => getUsage({ data: deps }),
  head: () => ({ meta: [{ title: 'Usage · Settings · crashyard' }] }),
  component: Usage,
})

const ALL = 'all'
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

function Usage() {
  const u = Route.useLoaderData()
  const { project } = Route.useSearch()
  const projects = useProjects()
  const navigate = useNavigate()
  const charts = [
    {
      title: 'Events',
      description:
        'Errors and crashes stored, and envelopes the daily limits, inbound filters or failures turned away.',
      series: [
        { key: 'accepted', label: 'Accepted', values: u.events, color: 'var(--color-sky-500)' },
        { key: 'dropped', label: 'Rate limited', values: u.dropped, color: 'var(--color-amber-500)' },
        { key: 'filtered', label: 'Filtered', values: u.filtered, color: 'var(--color-violet-500)' },
        { key: 'failed', label: 'Failed', values: u.failed, color: 'var(--color-red-500)' },
      ],
    },
    {
      title: 'Logs',
      description: 'Logs stored.',
      series: [{ key: 'logs', label: 'Accepted', values: u.logs, color: 'var(--color-emerald-500)' }],
    },
    {
      title: 'Transactions',
      description: 'Transactions and spans summarised.',
      series: [{ key: 'transactions', label: 'Accepted', values: u.transactions, color: 'var(--color-cyan-500)' }],
    },
  ]
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">The last 30 days, by UTC day.</p>
        <Select
          value={project ?? ALL}
          onValueChange={(v) =>
            void navigate({ to: '/settings/usage', search: { project: v === ALL ? undefined : v } })
          }
        >
          <SelectTrigger className="w-full @xl:w-56" aria-label="Project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.slug}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {charts.map((c) => (
        <SettingsCard key={c.title} title={c.title} description={c.description}>
          <dl className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {c.series.map((s) => (
              <div key={s.key} className="flex gap-1.5">
                <dt className="text-muted-foreground">{s.label}</dt>
                <dd className="font-medium tabular-nums">{count(sum(s.values))}</dd>
              </div>
            ))}
          </dl>
          <TimeChart x={u.days} series={c.series} legend={c.series.length > 1} height={160} />
        </SettingsCard>
      ))}
    </>
  )
}
