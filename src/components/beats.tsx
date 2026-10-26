// A monitor's recent history as bars: green for a good check or check-in, red for a bad one, taller when slower.
import { cn } from '@/lib/utils'

export function Beats({
  beats,
  className,
}: {
  beats: { at: number; ok: number; ms: number | null; status: string | number | null }[]
  className?: string
}) {
  const max = Math.max(1, ...beats.map((b) => b.ms ?? 0))
  const slots = 30
  const padded = [...Array(Math.max(0, slots - beats.length)).fill(null), ...beats.slice(-slots)]
  return (
    <div
      className={cn('flex h-7 items-end gap-0.5', className)}
      role="img"
      aria-label={`${beats.filter((b) => !b.ok).length} failures in the last ${beats.length}`}
    >
      {padded.map((b, i) =>
        b ? (
          <span
            key={i}
            title={`${new Date(b.at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${b.status ?? ''}${b.ms !== null ? ` · ${b.ms} ms` : ''}`}
            className={cn('w-1.5 rounded-sm', b.ok ? 'bg-emerald-500' : 'bg-red-500')}
            style={{ height: `${b.ok && b.ms !== null ? Math.max(25, (b.ms / max) * 100) : 100}%` }}
          />
        ) : (
          <span key={i} className="h-1 w-1.5 rounded-sm bg-border" />
        ),
      )}
    </div>
  )
}

export function MonitorStatus({ status }: { status: string }) {
  const style: Record<string, string> = {
    ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    failing: 'bg-red-500/15 text-red-700 dark:text-red-300',
    pending: 'bg-muted text-muted-foreground',
    paused: 'bg-muted text-muted-foreground',
  }
  const label: Record<string, string> = { ok: 'Up', failing: 'Failing', pending: 'Waiting', paused: 'Paused' }
  return (
    <span className={cn('rounded-md px-1.5 py-0.5 text-xs font-medium', style[status])}>{label[status] ?? status}</span>
  )
}

/** Why an incident opened, as a sentence: a cron run's outcome, or what the uptime check got */
export const incidentReason = (reason: string) =>
  ({ error: 'The run failed', missed: 'Missed its check-in', timeout: 'Ran longer than allowed' })[reason] ??
  reason[0].toUpperCase() + reason.slice(1)
