// A release's adoption stage and health, as badges
import { Badge } from '@/components/ui/badge'
import type { Stage } from '@/data/releases'
import { cn } from '@/lib/utils'

const STAGES: Record<Stage, { label: string; className: string }> = {
  adopted: { label: 'Adopted', className: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400' },
  low: { label: 'Low adoption', className: 'text-muted-foreground' },
  replaced: { label: 'Replaced', className: 'text-muted-foreground' },
}

export function AdoptionStage({ stage }: { stage: Stage }) {
  return (
    <Badge variant="outline" className={cn('shrink-0', STAGES[stage].className)}>
      {STAGES[stage].label}
    </Badge>
  )
}

export function HealthBadge({ healthy, failed }: { healthy: boolean; failed: string[] }) {
  return healthy ? (
    <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
      Healthy
    </Badge>
  ) : (
    <Badge variant="destructive" title={`Past the threshold for ${failed.join(' and ')}`}>
      Unhealthy
    </Badge>
  )
}
