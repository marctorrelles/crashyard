import { createFileRoute } from '@tanstack/react-router'
import { NewPerson, SignInFrame } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { ROLE_LABELS } from '@/data/people'
import { getInvitePage } from '@/fns'

export const Route = createFileRoute('/invite/$token')({
  loader: ({ params }) => getInvitePage({ data: { token: params.token } }),
  head: () => ({ meta: [{ title: 'Join · crashyard' }] }),
  component: Invite,
})

// Joining from an invite link: who sent it and the role it gives, then a name, an email and a passkey
function Invite() {
  const invite = Route.useLoaderData()
  const { token } = Route.useParams()
  if (!invite?.usable)
    return (
      <SignInFrame
        title="This invite can’t be used"
        description={
          invite
            ? `It has expired or was already used. Ask ${invite.inviter} for a new one.`
            : 'The link is incomplete, or the invite was withdrawn. Ask whoever sent it for a new one.'
        }
      >
        <Button asChild variant="outline" className="h-10">
          <a href="/signin">Sign in instead</a>
        </Button>
      </SignInFrame>
    )
  return (
    <NewPerson
      kind="invite"
      title="Join crashyard"
      description={
        <>
          {invite.inviter} invited you as {/^[aeiou]/i.test(invite.role) ? 'an' : 'a'}{' '}
          <span className="font-medium text-foreground">{ROLE_LABELS[invite.role]}</span>.
        </>
      }
      email={invite.email}
      extra={{ fields: null, body: () => ({ token }) }}
    />
  )
}
