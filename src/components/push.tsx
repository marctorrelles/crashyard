import { Link, useRouter } from '@tanstack/react-router'
import { IconDeviceDesktop, IconDeviceMobile } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Ago } from '@/components/bits'
import { Hint, SettingsCard, useSave } from '@/components/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { deletePushDevice, getPush, savePushDevice, testPush } from '@/fns'

type Data = Awaited<ReturnType<typeof getPush>>

/** What this browser can do: known only in the browser, so the server renders `loading` */
type State = 'loading' | 'unsupported' | 'homescreen' | 'denied' | 'off' | 'on'

const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const saveSubscription = (sub: PushSubscription) => {
  const { endpoint, keys } = sub.toJSON()
  return savePushDevice({ data: { endpoint, p256dh: keys?.p256dh, auth: keys?.auth } })
}

/** Whether this browser can take push and has it on; a subscription the server doesn't know is saved again, as a
 *  push service may have moved this browser to a new address */
async function browserState(devices: { endpoint: string }[]): Promise<{ state: State; endpoint: string | null }> {
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
    // An iPhone or iPad has push only in the app added to the Home Screen
    const ios = /iPhone|iPad/.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches
    return { state: ios ? 'homescreen' : 'unsupported', endpoint: null }
  }
  if (Notification.permission === 'denied') return { state: 'denied', endpoint: null }
  const sub = await (await navigator.serviceWorker.getRegistration('/'))?.pushManager.getSubscription()
  if (!sub || Notification.permission !== 'granted') return { state: 'off', endpoint: null }
  if (!devices.some((d) => d.endpoint === sub.endpoint)) await saveSubscription(sub).catch(() => {})
  return { state: 'on', endpoint: sub.endpoint }
}

/** Asks, subscribes and saves this browser; call it straight from a tap, as Safari only asks from one */
async function subscribe(key: string) {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications weren’t allowed, so none can be sent here.')
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) })
  await saveSubscription(sub)
  return sub.endpoint
}

// Push notifications on the viewer's own devices: this one on or off, a test, and the list (src/notify/push.ts).
// `here` on Notifications, whose routes are on the same page
export function Push({ push, here }: { push: Data; here?: boolean }) {
  const { save, saving } = useSave()
  const [state, setState] = useState<State>('loading')
  const [endpoint, setEndpoint] = useState<string | null>(null)

  useEffect(() => {
    void browserState(push.devices).then((s) => {
      setEndpoint(s.endpoint)
      setState(s.state)
    })
  }, [push.devices])

  const turnOn = () =>
    save(async () => {
      try {
        setEndpoint(await subscribe(push.key))
        setState('on')
      } catch (error) {
        if (Notification.permission === 'denied') setState('denied')
        throw error
      }
    }, 'Notifications are on for this device')

  const turnOff = () =>
    save(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/')
      await (await reg?.pushManager.getSubscription())?.unsubscribe()
      if (endpoint) await deletePushDevice({ data: { endpoint } })
      setEndpoint(null)
      setState('off')
    }, 'Notifications are off for this device')

  return (
    <SettingsCard
      title="Push notifications"
      description="Alerts on this device, even while crashyard is closed. Turn them on on each device you want them on."
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {state === 'on' ? (
            <>
              <Button
                variant="outline"
                disabled={saving}
                className="max-sm:h-10"
                onClick={() => void save(() => testPush({ data: { endpoint: endpoint! } }), 'Test notification sent')}
              >
                Send test notification
              </Button>
              <Button variant="ghost" disabled={saving} className="max-sm:h-10" onClick={() => void turnOff()}>
                Turn off on this device
              </Button>
            </>
          ) : (
            <Button disabled={saving || state !== 'off'} className="max-sm:h-10" onClick={() => void turnOn()}>
              Turn on notifications
            </Button>
          )}
        </div>
        {state === 'homescreen' && (
          <Hint>Add crashyard to your Home Screen from the Share menu, then open it from there to turn them on.</Hint>
        )}
        {state === 'unsupported' && <Hint>This browser can’t show notifications.</Hint>}
        {state === 'denied' && (
          <Hint>Notifications are blocked for crashyard. Allow them in this browser’s settings, then reload.</Hint>
        )}

        {push.devices.length > 0 && (
          <ul className="divide-y rounded-xl border text-sm">
            {push.devices.map((d) => {
              const Icon = /iPhone|Android/.test(d.name) ? IconDeviceMobile : IconDeviceDesktop
              return (
                <li key={d.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
                  <Icon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate font-medium">
                      {d.name === 'Passkey' ? 'Unknown browser' : d.name}
                      {d.endpoint === endpoint && <Badge variant="secondary">This device</Badge>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added <Ago at={d.created_at} now={push.now} />
                      {d.last_sent_at && (
                        <>
                          {' · '}last alert <Ago at={d.last_sent_at} now={push.now} />
                        </>
                      )}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    className="max-sm:h-10"
                    onClick={() =>
                      void (d.endpoint === endpoint
                        ? turnOff()
                        : save(() => deletePushDevice({ data: { id: d.id } }), 'Device removed'))
                    }
                  >
                    Remove
                  </Button>
                </li>
              )
            })}
          </ul>
        )}

        {push.channel && (
          <Hint>
            {here ? (
              push.channel.routes > 0 ? (
                <>Routes below send alerts to {push.channel.name}.</>
              ) : (
                <>{push.channel.name} isn’t in a route yet, so no alerts arrive. An admin adds it to one below.</>
              )
            ) : push.channel.routes > 0 ? (
              <>
                Routes send alerts to {push.channel.name}.{' '}
                <Link to="/notifications" className="underline underline-offset-2">
                  See them on Notifications
                </Link>
                .
              </>
            ) : (
              <>
                {push.channel.name} isn’t in a route yet, so no alerts arrive. An admin adds it to one on{' '}
                <Link to="/notifications" className="underline underline-offset-2">
                  Notifications
                </Link>
                .
              </>
            )}
          </Hint>
        )}
      </div>
    </SettingsCard>
  )
}

const PROMPTED = 'crashyard.push-prompted'

/** Once, in the app added to the Home Screen or installed: offers push when this device can take it and hasn't
 *  been asked. Dismissed for good on this device, in localStorage */
export function PushPrompt() {
  const router = useRouter()
  const [key, setKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem(PROMPTED)) return
    } catch {
      return
    }
    if (!matchMedia('(display-mode: standalone)').matches) return
    if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) return
    if (Notification.permission !== 'default') return
    void getPush().then((p) => setKey(p.key))
  }, [])

  const close = () => {
    try {
      localStorage.setItem(PROMPTED, '1')
    } catch {
      // ponytail: no storage (a private window) asks again next launch
    }
    setKey(null)
  }
  const turnOn = async () => {
    setBusy(true)
    try {
      await subscribe(key!)
      toast.success('Notifications are on for this device')
      close()
      await router.invalidate()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That couldn’t be saved. Try again.')
      if (Notification.permission === 'denied') close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!key} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Get alerts on this device</DialogTitle>
          <DialogDescription>
            Turn on notifications to hear about new issues, regressions and monitors going down, even while crashyard is
            closed. You can change this later in Settings, Preferences.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={busy} className="max-sm:h-10" onClick={close}>
            Not now
          </Button>
          <Button disabled={busy} className="max-sm:h-10" onClick={() => void turnOn()}>
            Turn on notifications
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
