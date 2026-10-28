import { getRouteApi, Link } from '@tanstack/react-router'
import { IconDeviceDesktop, IconDeviceMobile } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Ago } from '@/components/bits'
import { Hint, SettingsCard, useSave } from '@/components/settings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { deletePushDevice, savePushDevice, testPush } from '@/fns'

const route = getRouteApi('/settings/preferences')

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

// Push notifications on the viewer's own devices: this one on or off, a test, and the list (src/notify/push.ts)
export function Push() {
  const { push } = route.useLoaderData()
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
      // Asked first, straight from the tap: Safari only asks from one
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off')
        throw new Error('Notifications weren’t allowed, so none can be sent here.')
      }
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(push.key) })
      await saveSubscription(sub)
      setEndpoint(sub.endpoint)
      setState('on')
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
            {push.channel.routes > 0 ? (
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
