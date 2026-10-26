// Whether the main pointer can point precisely (a mouse, a trackpad), not a finger: a store subscription, as use-mobile
import { useSyncExternalStore } from 'react'

const QUERY = '(pointer: fine)'

const subscribe = (onChange: () => void) => {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

export function useFinePointer() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
