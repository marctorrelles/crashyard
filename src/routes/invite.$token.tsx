import { createFileRoute } from '@tanstack/react-router'
import { IconBrandGithub } from '@tabler/icons-react'
import { GITHUB_ERRORS, NewPerson, Or, SignInFrame } from '@/components/sign-in'
import { Button } from '@/components/ui/button'
import { ROLE_LABELS } from '@/data/people'
import { getInvitePage } from '@/fns'

export const Route = createFileRoute('/invite/$token')({
  validateSearch: (s: Record<string, unknown>): { error?: string } => ({
    error: typeof s.error === 'string' ? s.error : undefined,
  }),
  loader: ({ params }) => getInvitePage({ data: { token: params.token } }),
  head: () => ({ meta: [{ title: 'Join · crashyard' }] }),
  component: Invite,
})

// Joining from an invite link: who sent it and the role it gives, then a name, an email and a passkey
function Invite() {
  const invite = Route.useLoaderData()
  const { token } = Route.useParams()
  const { error } = Route.useSearch()
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
      failed={error && GITHUB_ERRORS[error]}
      alternative={
        invite.github && (
          <>
            <Or />
            <Button asChild variant="outline" className="h-11 text-base">
              <a href={`/auth/github/start?invite=${encodeURIComponent(token)}`}>
                <IconBrandGithub className="size-5" />
                Join with GitHub
              </a>
            </Button>
          </>
        )
      }
    />
  )
}
