import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { count } from '@/components/bits'
import { TimeChart } from '@/components/charts'
import { usePlan } from '@/components/plan'
import { SettingsCard, Status } from '@/components/settings'
import { useProjects } from '@/components/shell'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { size } from '@/components/uploads'
import { getHealth, getUsage } from '@/fns'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/settings/usage')({
  validateSearch: (s: Record<string, unknown>): { project?: string } => ({
    project: typeof s.project === 'string' && s.project ? s.project : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ deps }) => {
    const [usage, health] = await Promise.all([getUsage({ data: deps }), getHealth()])
    return { usage, health }
  },
  head: () => ({ meta: [{ title: 'Usage · Settings · crashyard' }] }),
  component: Usage,
})

const ALL = 'all'
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

function Usage() {
  const u = Route.useLoaderData().usage
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
      <CloudflarePlan />
      <Storage />
    </>
  )
}

// What needs Workers Paid, and what happens on Free
const PAID_FEATURES = [
  ['Debug file and source map uploads', 'Uploads fail on Free, so stack traces stay as the app sent them.'],
  ['Cloudflare Workers runs', 'Tail Workers need Paid, so no Worker can send its runs on Free.'],
  ['Import from Sentry', 'Goes 2 issues at a time on Free instead of 10.'],
] as const

function CloudflarePlan() {
  const { plan, recheck } = usePlan()
  const [checking, setChecking] = useState(false)
  return (
    <SettingsCard
      title="Cloudflare plan"
      description="Found by trying a limit that differs between Workers Free and Workers Paid, once a day."
    >
      <div className="grid gap-3">
        <p className="text-sm">
          {plan === undefined ? (
            'Checking…'
          ) : plan === null ? (
            'The plan couldn’t be found. Try again in a minute.'
          ) : (
            <>
              <span className="font-medium">{plan.paid ? 'Workers Paid' : 'Workers Free'}</span>
              <span className="text-muted-foreground">
                {' '}
                · checked <Time at={plan.checked} />
              </span>
            </>
          )}
        </p>
        {plan && (
          <div className="grid gap-1.5">
            {PAID_FEATURES.map(([feature, onFree]) => (
              <Status key={feature} ok={plan.paid}>
                {feature}
                {plan.paid ? ' work.' : `. ${onFree}`}
              </Status>
            ))}
          </div>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={checking || plan === undefined}
            onClick={async () => {
              setChecking(true)
              await recheck()
              setChecking(false)
            }}
          >
            Check again
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}

// How full the database is, and what the stored files take
function Storage() {
  const h = Route.useLoaderData().health
  const share = h.database.bytes === null ? null : h.database.bytes / h.database.limit
  return (
    <>
      <SettingsCard title="Database" description="D1 holds up to 10 GB in one database.">
        {share === null ? (
          <p className="text-sm text-muted-foreground">
            The size isn’t reported here. It is on Cloudflare’s dashboard.
          </p>
        ) : (
          <div className="grid gap-2">
            <p className="text-sm">
              <span className="font-medium">{size(h.database.bytes!)}</span>{' '}
              <span className="text-muted-foreground">of 10 GB, {(share * 100).toFixed(share < 0.1 ? 1 : 0)}%</span>
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full rounded-full', share >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500')}
                style={{ width: `${Math.max(1, Math.min(100, share * 100))}%` }}
              />
            </div>
            {share >= 0.8 && (
              <Status ok={false}>
                Over 80% full. Shorten event or log retention on the projects that keep the most.
              </Status>
            )}
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="Stored files" description="Uploads and attachments, kept in R2.">
        <dl className="grid gap-2 text-sm @xl:grid-cols-3">
          {[
            ['Debug files', h.files.debugFiles],
            ['Source maps', h.files.bundles],
            ['Attachments', h.files.attachments],
          ].map(([label, bytes]) => (
            <div key={label} className="grid">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{size(bytes as number)}</dd>
            </div>
          ))}
        </dl>
      </SettingsCard>
    </>
  )
}
