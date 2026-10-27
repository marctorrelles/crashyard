import { createFileRoute } from '@tanstack/react-router'
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react'
import { Ago, count } from '@/components/bits'
import { SettingsCard } from '@/components/settings'
import { size } from '@/components/uploads'
import { getHealth } from '@/fns'
import { cn } from '@/lib/utils'
import { KINDS, type NoticeKind, routeKindOf } from '@/notify/notice'

export const Route = createFileRoute('/settings/health')({
  loader: () => getHealth(),
  head: () => ({ meta: [{ title: 'Health · Settings · crashyard' }] }),
  component: Health,
})

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const Icon = ok ? IconCircleCheck : IconAlertTriangle
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-sm',
        ok ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

const capped = (n: { count: number; more: boolean }) => (n.more ? `${count(n.count)} or more` : count(n.count))

function Health() {
  const h = Route.useLoaderData()
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

      <SettingsCard
        title="Scheduled jobs"
        description="Every minute, crashyard checks monitors, sends held notifications and retries envelopes."
      >
        <Status ok={!h.cron.late}>
          {h.cron.lastRun === null ? (
            'The schedule hasn’t run yet. Check the cron trigger in wrangler.jsonc, then deploy again.'
          ) : h.cron.late ? (
            <>
              Late. The last run was <Ago at={h.cron.lastRun} now={h.now} />. Check the worker’s cron trigger on
              Cloudflare’s dashboard.
            </>
          ) : (
            <>
              On time. The last run was <Ago at={h.cron.lastRun} now={h.now} />.
            </>
          )}
        </Status>
      </SettingsCard>

      <SettingsCard title="Notifications" description="Notifications a channel refused in the last 7 days.">
        {h.notifications.failed === 0 ? (
          <Status ok>Every notification went through.</Status>
        ) : (
          <div className="grid gap-3">
            <Status ok={false}>
              {count(h.notifications.failed)} failed. Test the channel on Notifications to see what it answers.
            </Status>
            <ul className="divide-y rounded-xl border text-sm">
              {h.notifications.recent.map((f) => (
                <li key={f.id} className="grid gap-0.5 px-3 py-2">
                  <p className="font-medium">
                    {f.channel ?? 'A deleted channel'}{' '}
                    <span className="font-normal text-muted-foreground">
                      · {kindLabel(f.kind)} · <Ago at={f.at} now={h.now} />
                    </span>
                  </p>
                  <p className="text-xs break-words text-muted-foreground">{f.error}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Envelopes"
        description="An envelope that fails to store is tried again every few minutes, up to five times."
      >
        <div className="grid gap-1">
          <Status ok={h.envelopes.pending.count === 0}>
            {h.envelopes.pending.count === 0
              ? 'Nothing is waiting for another try.'
              : `${capped(h.envelopes.pending)} waiting for another try.`}
          </Status>
          <Status ok={h.envelopes.failed.count === 0}>
            {h.envelopes.failed.count === 0
              ? 'No envelope failed every try.'
              : `${capped(h.envelopes.failed)} failed every try. They’re kept in R2 under failed/.`}
          </Status>
        </div>
      </SettingsCard>

      <SettingsCard title="Retention" description="Every hour, crashyard deletes what’s past each project’s retention.">
        <Status ok={h.backlog.events === 0 && h.backlog.logs === 0}>
          {h.backlog.events === 0 && h.backlog.logs === 0
            ? 'Nothing is waiting to be deleted.'
            : `${count(h.backlog.events)}${h.backlog.events >= 10_000 ? ' or more' : ''} events and ${count(h.backlog.logs)}${h.backlog.logs >= 10_000 ? ' or more' : ''} logs are waiting. The next hours delete them.`}
        </Status>
      </SettingsCard>
    </>
  )
}

/** A notice's kind as Notifications names it: "Metric alert", never `metric_critical` */
const kindLabel = (kind: string) => KINDS.find((k) => k.kind === routeKindOf(kind as NoticeKind))?.label ?? kind
