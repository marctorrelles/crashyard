// The Cloudflare plan, for what needs Workers Paid: asked after the page loads, so no page waits for the check
import { useEffect, useState } from 'react'
import type { Plan } from '@/data/plan'
import { getPlan } from '@/fns'

/** The plan, null when it couldn't be found, undefined while asking; and a way to check again now */
export function usePlan() {
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined)
  useEffect(() => {
    getPlan({ data: {} }).then(setPlan, () => setPlan(null))
  }, [])
  const recheck = async () => setPlan(await getPlan({ data: { fresh: true } }).catch(() => null))
  return { plan, recheck }
}

/** A warning shown only on Workers Free, saying what doesn't work there */
export function NeedsPaid({ children }: { children: React.ReactNode }) {
  const { plan } = usePlan()
  return plan?.paid === false && <PaidNote>{children}</PaidNote>
}

/** The amber note itself, for a page that knows the plan already */
export function PaidNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
      {children}
    </p>
  )
}
