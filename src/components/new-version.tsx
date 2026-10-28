import { useEffect } from 'react'
import { toast } from 'sonner'

declare const __BUILD__: string

const EVERY = 15 * 60_000

// A newer deploy than this page's: an app added to the Home Screen or installed stays open for days, so it asks
// `/version.json` (vite.config.ts) on coming back to the front and every 15 minutes, and offers a reload in a toast
// that stays until closed
export function NewVersion() {
  useEffect(() => {
    let shown = false
    const check = async () => {
      if (shown || document.visibilityState !== 'visible') return
      try {
        const res = await fetch('/version.json', { cache: 'no-store' })
        const { build } = (await res.json()) as { build: string }
        if (!build || build === __BUILD__) return
      } catch {
        return // offline, mid-deploy, or a dev server, which has none: the next check asks again
      }
      shown = true
      toast('A new version of crashyard is ready', {
        id: 'new-version',
        duration: Infinity,
        closeButton: true,
        action: { label: 'Reload', onClick: () => location.reload() },
      })
    }
    const timer = setInterval(() => void check(), EVERY)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])
  return null
}
