import { createFileRoute, getRouteApi, notFound } from '@tanstack/react-router'
import { IconFileCode, IconSearch, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { Ago } from '@/components/bits'
import { SettingsCard, useSave } from '@/components/settings'
import { Empty } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { size, UploadSteps } from '@/components/uploads'
import { deleteDebugFile, getProjectPage } from '@/fns'

export const Route = createFileRoute('/settings/projects/$slug/debug-files')({
  loader: async ({ params }) => {
    const data = await getProjectPage({ data: { slug: params.slug } })
    if (!data) throw notFound()
    return data
  },
  component: DebugFiles,
})

const parent = getRouteApi('/settings/projects/$slug')

const kindOf = (f: { kind: string; arch: string | null }) =>
  f.kind === 'proguard' ? 'ProGuard mapping' : `${f.kind}${f.arch ? ` ${f.arch}` : ''}`

function DebugFiles() {
  const { project, origin, uploads } = parent.useLoaderData()
  const { debugFiles, now } = Route.useLoaderData()
  const { save } = useSave()
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? debugFiles.filter((f) => f.name.toLowerCase().includes(q) || f.debug_id.toLowerCase().includes(q))
    : debugFiles
  return (
    <>
      <SettingsCard
        title="Upload symbols and source maps"
        description="Crashes then show function names, files and line numbers."
      >
        <UploadSteps slug={project.slug} platform={project.platform} origin={origin} />
      </SettingsCard>

      <SettingsCard title="Debug files" description="dSYMs, ProGuard mappings and other symbol files, newest first.">
        {debugFiles.length === 0 ? (
          <Empty icon={IconFileCode} title="No debug files yet" compact>
            They appear here after the first upload from sentry-cli or a build plugin.
          </Empty>
        ) : (
          <div className="grid gap-3">
            <InputGroup className="sm:max-w-sm">
              <InputGroupAddon>
                <IconSearch />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or debug ID"
                aria-label="Search debug files"
              />
            </InputGroup>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground">No debug file matches {query.trim()}.</p>
            ) : (
              <ul className="divide-y rounded-xl border text-sm">
                {shown.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {f.name} <span className="font-normal text-muted-foreground">· {kindOf(f)}</span>
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{f.debug_id}</p>
                      <p className="text-xs text-muted-foreground">
                        {size(f.size)} · <Ago at={f.created_at} now={now} />
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="max-sm:size-10"
                      aria-label={`Delete ${f.name}`}
                      onClick={() => {
                        if (
                          !confirm(
                            `Delete ${f.name} (${kindOf(f)})? New crashes that need it show addresses until it’s uploaded again. This can’t be undone.`,
                          )
                        )
                          return
                        void save(
                          () => deleteDebugFile({ data: { project: project.id, id: f.id } }),
                          `${f.name} deleted`,
                        )
                      }}
                    >
                      <IconTrash />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsCard>

      {uploads.bundles.length > 0 && (
        <SettingsCard title="Source maps" description="Artifact bundles, the newest 10.">
          <ul className="divide-y rounded-xl border text-sm">
            {uploads.bundles.map((b) => (
              <li key={b.checksum} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2">
                <span className="min-w-0 flex-1 truncate">
                  {b.files} file{b.files === 1 ? '' : 's'}
                  {b.release && ` · ${b.release}`}
                </span>
                <span className="text-xs text-muted-foreground">
                  {size(b.size)} · <Ago at={b.created_at} now={now} />
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
    </>
  )
}
