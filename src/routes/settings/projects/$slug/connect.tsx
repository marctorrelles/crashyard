import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { Code, Linking } from '@/components/linking'
import { SettingsCard } from '@/components/settings'
import { Label } from '@/components/ui/label'

export const Route = createFileRoute('/settings/projects/$slug/connect')({ component: Connect })

const parent = getRouteApi('/settings/projects/$slug')

function Connect() {
  const { project, dsn, publicKey, origin } = parent.useLoaderData()
  return (
    <SettingsCard
      title="Connect an app"
      description={
        <>
          Give the app’s Sentry SDK this DSN and its events start arriving here. Other keys are in{' '}
          <Link
            to="/settings/projects/$slug/keys"
            params={{ slug: project.slug }}
            className="font-medium text-foreground underline underline-offset-2"
          >
            Client keys
          </Link>
          .
        </>
      }
    >
      <div className="mb-5 grid min-w-0 gap-2">
        <Label>DSN</Label>
        <Code text={dsn} />
      </div>
      <Linking platform={project.platform} dsn={dsn} origin={origin} id={project.id} publicKey={publicKey} />
    </SettingsCard>
  )
}
