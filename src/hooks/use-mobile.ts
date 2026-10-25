// shadcn's hook (for the sidebar), as a store subscription instead of state set in an effect
import { useSyncExternalStore } from 'react'

const QUERY = '(max-width: 767px)'

const subscribe = (onChange: () => void) => {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
