import { createFileRoute } from '@tanstack/react-router'
import { Ago, count } from '@/components/bits'
import { SettingsCard, Status } from '@/components/settings'
import { getHealth } from '@/fns'
import { KINDS, type NoticeKind, routeKindOf } from '@/notify/notice'

export const Route = createFileRoute('/settings/health')({
  loader: () => getHealth(),
  head: () => ({ meta: [{ title: 'Health · Settings · crashyard' }] }),
  component: Health,
})

const capped = (n: { count: number; more: boolean }) => (n.more ? `${count(n.count)} or more` : count(n.count))

// Whether the work crashyard does in the background runs: the schedule, notifications, retries and retention
function Health() {
  const h = Route.useLoaderData()
  return (
    <>
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
