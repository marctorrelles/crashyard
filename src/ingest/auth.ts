// The project key an SDK sends: in X-Sentry-Auth, the sentry_key query parameter (browsers, to skip a preflight),
// an Authorization header carrying the DSN, or the envelope header's dsn.

const keyIn = (header: string | null) => header?.match(/sentry_key=([^,\s]+)/)?.[1] ?? null

export function projectKey(request: Request, url: URL, envelopeDsn?: unknown): string | null {
  const dsnKey = (dsn: unknown) => {
    if (typeof dsn !== 'string') return null
    try {
      return new URL(dsn).username || null
    } catch {
      return null
    }
  }
  return (
    keyIn(request.headers.get('x-sentry-auth')) ??
    url.searchParams.get('sentry_key') ??
    keyIn(request.headers.get('authorization')) ??
    dsnKey(request.headers.get('authorization')?.replace(/^DSN\s+/i, '')) ??
    dsnKey(envelopeDsn)
  )
}
