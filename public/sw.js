// crashyard's service worker: shows push notifications (src/notify/push.ts) and opens what a tap points at. No fetch
// handler, no cache: the app stays online only.

// Open windows come under it at once, so a tap can move one to the notice's page
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  const n = event.data?.json() ?? {}
  event.waitUntil(
    self.registration.showNotification(n.title ?? 'crashyard', {
      body: n.body,
      tag: n.tag,
      icon: '/icon-192.png',
      silent: n.silent,
      data: { url: n.url ?? '/', actions: Object.fromEntries((n.actions ?? []).map((a) => [a.action, a.url])) },
      actions: (n.actions ?? []).map((a) => ({ action: a.action, title: a.title })),
    }),
  )
})

// An action opens its confirm-on-the-page link, anything else the notice's page: in an open crashyard window if
// there is one
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url, actions } = event.notification.data ?? {}
  const target = new URL((event.action && actions?.[event.action]) || url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (!open) return self.clients.openWindow(target)
      return open
        .focus()
        .then((w) => w.navigate(target))
        .catch(() => self.clients.openWindow(target))
    }),
  )
})
