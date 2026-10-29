import { createFileRoute, Link } from '@tanstack/react-router'
import {
  IconActivity,
  IconBell,
  IconBug,
  IconCalendarWeek,
  IconChartLine,
  IconGauge,
  IconSettings,
} from '@tabler/icons-react'
import { Ago } from '@/components/bits'
import { Empty, PageHeader, Shell } from '@/components/shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getSentNotifications } from '@/fns'
import { ISSUE_KINDS, type NoticeKind, noticeLine } from '@/notify/notice'

export const Route = createFileRoute('/notifications')({
  loader: () => getSentNotifications(),
  head: () => ({ meta: [{ title: 'Notifications · crashyard' }] }),
  component: Notifications,
})

const iconOf = (kind: NoticeKind) =>
  ISSUE_KINDS.has(kind)
    ? IconBug
    : kind.startsWith('monitor_')
      ? IconActivity
      : kind.startsWith('metric_')
        ? IconChartLine
        : kind === 'weekly'
          ? IconCalendarWeek
          : IconGauge

const STATE = { sent: '', held: ' · held for quiet hours', failed: ' · not sent' }

// What crashyard sent, newest first: each notice as its channels got it, with where it went and what didn't go
function Notifications() {
  const { sent, now } = Route.useLoaderData()
  return (
    <Shell crumbs={['Notifications']}>
      <PageHeader
        title="Notifications"
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link to="/settings/notifications">
              <IconSettings data-icon="inline-start" />
              Notification settings
            </Link>
          </Button>
        }
      >
        What crashyard sent in the last 30 days.
      </PageHeader>
      {sent.length === 0 ? (
        <Empty
          icon={IconBell}
          title="Nothing sent yet"
          action={
            <Button asChild>
              <Link to="/settings/notifications">Set up notifications</Link>
            </Button>
          }
        >
          Alerts show up here once a route sends one to a channel.
        </Empty>
      ) : (
        <ul className="divide-y rounded-xl border">
          {sent.map((s) => {
            const Icon = iconOf(s.notice.kind)
            const failed = s.deliveries.filter((d) => d.state === 'failed')
            return (
              // The icon shares the title's row, so it stays centred on it whatever the title's tap padding
              <li key={s.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 px-4 py-3">
                <Icon className="size-4 text-muted-foreground" />
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <Link
                    to={s.path}
                    className="min-w-0 truncate text-sm font-medium underline-offset-2 hover:underline max-sm:py-1"
                  >
                    {s.notice.issue.title}
                  </Link>
                  <Ago at={s.at} now={now} className="shrink-0 text-xs text-muted-foreground" />
                </div>
                <div className="col-start-2 mt-1 grid min-w-0 grid-cols-1 gap-1">
                  <p className="text-xs break-words text-muted-foreground">{noticeLine(s.notice)}</p>
                  <div className="flex flex-wrap gap-1">
                    {s.deliveries.map((d, i) => (
                      <Badge key={i} variant={d.state === 'failed' ? 'destructive' : 'secondary'}>
                        {d.channel ?? 'A deleted channel'}
                        {STATE[d.state]}
                      </Badge>
                    ))}
                  </div>
                  {failed.map((d, i) => (
                    <p key={i} className="text-xs break-words text-destructive">
                      {d.channel ?? 'A deleted channel'}: {d.error}
                    </p>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Shell>
  )
}
