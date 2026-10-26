import { createFileRoute } from '@tanstack/react-router'
import { ReadOnly, SettingsCard } from '@/components/settings'
import { getInstanceSettings } from '@/fns'

export const Route = createFileRoute('/settings/about')({
  loader: () => getInstanceSettings(),
  head: () => ({ meta: [{ title: 'About · Settings · crashyard' }] }),
  component: About,
})

const DOCS = 'https://github.com/marctorrelles/crashyard/blob/main/docs'

function About() {
  const { version, update } = Route.useLoaderData()
  const link = 'font-medium underline underline-offset-2'
  return (
    <>
      <SettingsCard title="crashyard">
        <ReadOnly
          label="Version"
          value={version}
          note={
            update ? (
              <>
                {update.version} is available.{' '}
                <a href={update.url} className={link}>
                  See what’s new
                </a>{' '}
                or{' '}
                <a href={`${DOCS}/upgrading.md`} className={link}>
                  how to upgrade
                </a>
                .
              </>
            ) : (
              'This is the newest release.'
            )
          }
        />
      </SettingsCard>
      <SettingsCard title="Documentation">
        <ul className="grid gap-1.5 text-sm">
          {[
            ['Deploying', 'deploying.md'],
            ['Linking an app', 'linking.md'],
            ['Upgrading', 'upgrading.md'],
            ['The MCP server', 'mcp.md'],
            ['Sentry compatibility', 'sentry-compatibility.md'],
          ].map(([label, file]) => (
            <li key={file}>
              <a href={`${DOCS}/${file}`} className={link}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </>
  )
}
