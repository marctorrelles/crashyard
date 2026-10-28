// The sign-in pages' pieces (/signin, /setup, /invite): their frame, the passkey ceremonies against /auth/*
// (src/auth/passkeys.ts) and the recovery codes shown once.
import { IconCheck, IconCopy, IconDownload, IconFingerprint } from '@tabler/icons-react'
import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser'
import { useState } from 'react'
import { Logo } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** A sign-in page: the mark, a title and a line under it, then the page's content, alone in the middle */
export function SignInFrame({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/40 px-4 py-10">
      <div className="grid w-full max-w-sm gap-6">
        <div className="flex items-center justify-center gap-2.5">
          <Logo className="size-8 fill-foreground" />
          <span className="text-lg font-semibold tracking-tight">crashyard</span>
        </div>
        <section className="grid gap-5 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <div className="grid gap-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-sm text-balance text-muted-foreground">{description}</p>}
          </div>
          {children}
        </section>
        {footer && <div className="text-center text-sm text-muted-foreground">{footer}</div>}
      </div>
    </main>
  )
}

/** A POST to /auth/<path>: its JSON, or what went wrong as an Error with a sentence to show */
export async function auth<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
  const response = await fetch(`/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok)
    throw new Error(answer.error ?? 'crashyard couldn’t be reached. Check your connection and try again.')
  return answer
}

// The browser's refusals, in words: a cancelled prompt is the common one
function passkeyError(error: unknown, creating: boolean): Error {
  const name = error instanceof WebAuthnError ? (error.cause as Error | undefined)?.name : (error as Error)?.name
  if (name === 'NotAllowedError' || name === 'AbortError')
    return new Error(
      creating
        ? 'No passkey was created. Try again when you’re ready.'
        : 'No passkey was used. Try again when you’re ready.',
    )
  if (name === 'InvalidStateError')
    return new Error('This device already has a passkey for you. Use another device, or sign in with it.')
  if (name === 'NotSupportedError' || name === 'SecurityError')
    return new Error(
      'This browser can’t use passkeys here. Try another browser, or open crashyard at its usual address.',
    )
  return error instanceof Error ? error : new Error('Something went wrong with the passkey. Try again.')
}

/** Creates a passkey: `setup`, `invite` or `passkeys` (another for whoever is signed in) */
export async function createPasskey<T = Record<string, unknown>>(kind: string, body: unknown = {}) {
  const { id, options } = await auth<{ id: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>(
    `${kind}/options`,
    body,
  )
  const response = await startRegistration({ optionsJSON: options }).catch((e) => {
    throw passkeyError(e, true)
  })
  return auth<T>(`${kind}/verify`, { id, response })
}

export async function signInWithPasskey() {
  const { id, options } = await auth<{ id: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>(
    'signin/options',
  )
  const response = await startAuthentication({ optionsJSON: options }).catch((e) => {
    throw passkeyError(e, false)
  })
  return auth('signin/verify', { id, response })
}

export { nextPath } from '@/lib/next'

/** Ten recovery codes, shown once, to copy or download */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false)
  const text = `crashyard recovery codes for ${location.host}\nEach works once, with your email, if you lose your passkeys.\n\n${codes.join('\n')}\n`
  return (
    <div className="grid gap-3">
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 p-4 font-mono text-sm tabular-nums">
        {codes.map((c) => (
          <li key={c} className="text-center">
            {c}
          </li>
        ))}
      </ol>
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          className="h-10"
          onClick={async () => {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <IconCheck /> : <IconCopy />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="outline" className="h-10" asChild>
          <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="crashyard-recovery-codes.txt">
            <IconDownload />
            Download
          </a>
        </Button>
      </div>
    </div>
  )
}

/** What went wrong, under the form */
export const Problem = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
    {children}
  </p>
)

/**
 * Someone new: their name and email (fixed when an invite names it), any fields of the page's own first (the setup
 * code), then Create passkey; once it's made, their recovery codes and Continue to crashyard
 */
export function NewPerson({
  kind,
  title,
  description,
  email,
  extra,
  alternative,
  failed,
}: {
  kind: 'setup' | 'invite'
  title: string
  description: React.ReactNode
  email?: string | null
  extra?: { fields: React.ReactNode; body: (form: FormData) => Record<string, unknown> }
  /** Another way to join, under Create passkey: an invite's Join with GitHub */
  alternative?: React.ReactNode
  /** What went wrong before the page opened */
  failed?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(failed)
  const [codes, setCodes] = useState<string[]>()
  if (codes)
    return (
      <SignInFrame
        title="Save your recovery codes"
        description="If you ever lose your passkeys, sign in with your email and one of these. Each works once, and they won’t be shown again."
      >
        <RecoveryCodes codes={codes} />
        <Button className="h-10" onClick={() => window.location.assign('/')}>
          Continue to crashyard
        </Button>
      </SignInFrame>
    )
  return (
    <SignInFrame title={title} description={description}>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          setBusy(true)
          setError(undefined)
          try {
            const body = { name: form.get('name'), email: email ?? form.get('email'), ...extra?.body(form) }
            setCodes((await createPasskey<{ codes: string[] }>(kind, body)).codes)
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err))
          } finally {
            setBusy(false)
          }
        }}
      >
        {extra?.fields}
        <div className="grid gap-2">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required maxLength={80} className="h-10" />
        </div>
        <div className="grid gap-2">
          {email ? <p className="text-sm font-medium">Email</p> : <Label htmlFor="email">Email</Label>}
          {email ? (
            <p id="email" className="flex h-10 items-center rounded-lg border bg-muted/40 px-3 text-sm">
              {email}
            </p>
          ) : (
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={200}
              className="h-10"
            />
          )}
        </div>
        {error && <Problem>{error}</Problem>}
        <Button type="submit" className="h-11 text-base" disabled={busy}>
          <IconFingerprint className="size-5" />
          Create passkey
        </Button>
        <p className="text-center text-xs text-balance text-muted-foreground">
          Your device keeps the passkey and unlocks it with your face, fingerprint or screen lock.
        </p>
        {alternative}
      </form>
    </SignInFrame>
  )
}

/** What went wrong signing in with GitHub, from `?error=` (src/auth/github.ts) */
export const GITHUB_ERRORS: Record<string, string> = {
  'github-stale': 'That took too long, or started in another browser. Try again.',
  'github-cancelled': 'GitHub didn’t sign you in. Try again when you’re ready.',
  'github-failed': 'GitHub couldn’t be reached. Try again in a moment.',
  'github-unknown':
    'No one here uses that GitHub account or its email addresses. Ask an owner for an invite, or sign in with a passkey.',
  'github-email': 'This invite is for another email. Sign in to GitHub with the account that has it.',
  'github-no-email': 'Your GitHub account has no verified email. Verify one on GitHub, then try again.',
  'invite-used': 'This invite has expired or was already used. Ask whoever sent it for a new one.',
}

/** The line between passkeys and GitHub */
export const Or = () => (
  <div className="flex items-center gap-3 text-xs text-muted-foreground">
    <span className="h-px flex-1 bg-border" />
    or
    <span className="h-px flex-1 bg-border" />
  </div>
)
