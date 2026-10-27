import { createFileRoute } from '@tanstack/react-router'
import { PaidNote } from '@/components/plan'
import { NewPerson, SignInFrame } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getSetupPage } from '@/fns'

export const Route = createFileRoute('/setup')({
  loader: () => getSetupPage(),
  head: () => ({ meta: [{ title: 'Set up · crashyard' }] }),
  component: Setup,
})

// The first owner: the setup code from the deployment, their name and email, then their passkey
function Setup() {
  const { ready, done, plan } = Route.useLoaderData()
  if (done)
    return (
      <SignInFrame title="crashyard is set up" description="Sign in with your passkey, or ask an owner for an invite.">
        <Button asChild className="h-10">
          <a href="/signin">Sign in</a>
        </Button>
      </SignInFrame>
    )
  if (!ready)
    return (
      <SignInFrame
        title="Set up crashyard"
        description="Run pnpm run setup to make a setup code, or add a secret named SETUP_CODE under the worker’s Variables and Secrets in Cloudflare. Then reload this page."
      >
        <Button variant="outline" className="h-10" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </SignInFrame>
    )
  return (
    <NewPerson
      kind="setup"
      title="Set up crashyard"
      description="You’ll be its owner. Then you can invite everyone else."
      extra={{
        fields: (
          <>
            {plan?.paid === false && (
              <PaidNote>
                This Cloudflare account is on Workers Free. crashyard runs on it, but uploading symbols and source maps
                and catching Cloudflare Workers runs need Workers Paid. Without them, crashes from iOS, Android and
                minified web apps keep the stack traces the app sent.
              </PaidNote>
            )}
            <div className="grid gap-2">
              <Label htmlFor="code">Setup code</Label>
              <Input
                id="code"
                name="code"
                required
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="ABCDE-FGHJK-MNPQR"
                className="h-10 font-mono uppercase placeholder:normal-case"
              />
            </div>
          </>
        ),
        body: (form) => ({ code: form.get('code') }),
      }}
    />
  )
}
