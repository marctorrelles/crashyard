import { createFileRoute } from '@tanstack/react-router'
import { IconArrowLeft, IconBrandGithub, IconFingerprint } from '@tabler/icons-react'
import { useState } from 'react'
import { auth, GITHUB_ERRORS, nextPath, Or, Problem, SignInFrame, signInWithPasskey } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getSignInPage } from '@/fns'

export const Route = createFileRoute('/signin')({
  validateSearch: (s: Record<string, unknown>): { next?: string; error?: string } => ({
    next: typeof s.next === 'string' ? s.next : undefined,
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
  loader: () => getSignInPage(),
  head: () => ({ meta: [{ title: 'Sign in · crashyard' }] }),
  component: SignIn,
})

// Signing in: a passkey the browser picks, so there's nothing to type; a recovery code for whoever lost theirs
function SignIn() {
  const { next, error: failed } = Route.useSearch()
  const { github } = Route.useLoaderData()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(failed && GITHUB_ERRORS[failed])
  const [recovering, setRecovering] = useState(false)
  const run = async (step: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await step()
      // A whole page load, so every page's data is read again signed in
      window.location.assign(nextPath(next))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  if (recovering)
    return (
      <SignInFrame
        title="Use a recovery code"
        description="Each code works once. Once you’re in, add a new passkey in Settings."
        footer={
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
            onClick={() => (setRecovering(false), setError(undefined))}
          >
            <IconArrowLeft className="size-4" />
            Sign in with a passkey
          </button>
        }
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            const form = new FormData(e.currentTarget)
            void run(() => auth('recover', { email: form.get('email'), code: form.get('code') }))
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required className="h-10" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="code">Recovery code</Label>
            <Input
              id="code"
              name="code"
              required
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="ABCDE-FGHJK"
              className="h-10 font-mono uppercase placeholder:normal-case"
            />
          </div>
          {error && <Problem>{error}</Problem>}
          <Button type="submit" className="h-10" disabled={busy}>
            Sign in
          </Button>
        </form>
      </SignInFrame>
    )
  return (
    <SignInFrame
      title="Sign in to crashyard"
      description="Use the passkey on this device, or one on your phone."
      footer={
        <button
          type="button"
          className="font-medium text-foreground underline-offset-4 hover:underline"
          onClick={() => (setRecovering(true), setError(undefined))}
        >
          Lost your passkey? Use a recovery code
        </button>
      }
    >
      <div className="grid gap-3">
        <Button className="h-11 text-base" disabled={busy} onClick={() => void run(signInWithPasskey)}>
          <IconFingerprint className="size-5" />
          Sign in with a passkey
        </Button>
        {github && (
          <>
            <Or />
            <Button asChild variant="outline" className="h-11 text-base">
              <a href={`/auth/github/start?next=${encodeURIComponent(nextPath(next))}`}>
                <IconBrandGithub className="size-5" />
                Sign in with GitHub
              </a>
            </Button>
          </>
        )}
        {error && <Problem>{error}</Problem>}
      </div>
    </SignInFrame>
  )
}
