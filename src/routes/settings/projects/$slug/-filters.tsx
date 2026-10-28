import { getRouteApi } from '@tanstack/react-router'
import { useState } from 'react'
import { count } from '@/components/bits'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { updateProject } from '@/fns'
import { FILTER_SWITCHES, parseFilters } from '@/ingest/filters'

const parent = getRouteApi('/settings/projects/$slug')

const SWITCHES: Record<(typeof FILTER_SWITCHES)[number], { label: string; hint: string }> = {
  browserExtensions: {
    label: 'Browser extensions',
    hint: 'Errors from extensions and injected scripts, by Sentry’s list of their sources and messages.',
  },
  localhost: { label: 'Localhost', hint: 'Events from localhost or 127.0.0.1, such as a dev server.' },
  legacyBrowsers: {
    label: 'Legacy browsers',
    hint: 'Internet Explorer, and Chrome, Edge and Firefox before 111, Safari before 16, Opera before 100.',
  },
  webCrawlers: { label: 'Web crawlers', hint: 'Search engines, link previews, uptime checkers and AI crawlers.' },
  healthChecks: {
    label: 'Health checks',
    hint: 'Transactions named like /health, /healthz, /ping, /ready or /live.',
  },
  hydration: { label: 'React hydration errors', hint: 'React errors 418 to 425, when the page and the server differ.' },
  chunkLoad: { label: 'ChunkLoadError', hint: 'A script chunk that failed to load, often after a deploy.' },
}

const LISTS = [
  {
    key: 'messages',
    label: 'Error messages',
    hint: 'One a line. Use * as a wildcard, such as *ResizeObserver loop*. Case doesn’t matter.',
  },
  { key: 'releases', label: 'Releases', hint: 'One a line, such as app@1.0.* for every 1.0 build.' },
  {
    key: 'domains',
    label: 'Allowed domains',
    hint: 'One a line, such as app.example.com or *.example.com. Leave it empty to accept every domain. Apps that send no origin are always accepted.',
  },
] as const

export function Filters() {
  const { project, filtered } = parent.useLoaderData()
  const { save, saving } = useSave()
  const stored = parseFilters(project.filters)
  const [on, setOn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(FILTER_SWITCHES.map((k) => [k, !!stored[k]])),
  )
  const [lists, setLists] = useState<Record<string, string>>(() =>
    Object.fromEntries(LISTS.map((l) => [l.key, (stored[l.key] ?? []).join('\n')])),
  )
  return (
    <SettingsCard
      title="Inbound filters"
      description={
        <>
          Drop events you don’t want before they’re stored. They don’t count towards the daily limits.{' '}
          {filtered === 0
            ? 'Nothing was filtered in the last 30 days.'
            : `${count(filtered)} ${filtered === 1 ? 'event was' : 'events were'} filtered in the last 30 days.`}
        </>
      }
    >
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => updateProject({ data: { id: project.id, filters: { ...on, ...lists } } }))
        }}
      >
        <div className="grid gap-4">
          {FILTER_SWITCHES.map((key) => (
            <div key={key} className="flex items-start gap-3">
              <Switch
                id={`filter-${key}`}
                checked={on[key]}
                onCheckedChange={(v) => setOn({ ...on, [key]: v })}
                className="mt-0.5"
              />
              <div className="grid gap-0.5">
                <Label htmlFor={`filter-${key}`}>{SWITCHES[key].label}</Label>
                <Hint>{SWITCHES[key].hint}</Hint>
              </div>
            </div>
          ))}
        </div>
        {LISTS.map((l) => (
          <div key={l.key} className="grid gap-2">
            <Label htmlFor={`filter-${l.key}`}>{l.label}</Label>
            <Textarea
              id={`filter-${l.key}`}
              value={lists[l.key]}
              onChange={(e) => setLists({ ...lists, [l.key]: e.target.value })}
              rows={3}
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Hint>{l.hint}</Hint>
          </div>
        ))}
        <Hint>Changes apply to new events within a minute.</Hint>
        <div>
          <SaveButton saving={saving} />
        </div>
      </form>
    </SettingsCard>
  )
}
