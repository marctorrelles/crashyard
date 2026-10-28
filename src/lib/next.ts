// Where to go once signed in: a path on this site only. Read as the browser reads it, so `/\evil.com` or a tab in
// `/<tab>/evil.com`, which browsers turn into `//evil.com`, go home instead of off the site
const HERE = 'https://crashyard.invalid'

export function nextPath(next: unknown) {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/'
  try {
    // Not URL.parse: Safari before 18 hasn't it
    const url = new URL(next, HERE)
    return url.origin === HERE ? `${url.pathname}${url.search}${url.hash}` : '/'
  } catch {
    return '/'
  }
}
