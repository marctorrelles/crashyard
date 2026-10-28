// The settings area's pieces: its pages (the deployment's, Projects, the viewer's own), the left list (a select on a
// phone), and what each page is made of.
import { getRouteApi, Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useProjects } from '@/components/shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

const root = getRouteApi('__root__')

type Page = { label: string; path: string; owners?: boolean }

const INSTANCE: Page[] = [
  { label: 'General', path: '/settings/general' },
  { label: 'People', path: '/settings/people', owners: true },
  { label: 'Privacy', path: '/settings/privacy' },
  { label: 'Tokens', path: '/settings/tokens' },
  { label: 'Usage', path: '/settings/usage' },
  { label: 'Health', path: '/settings/health' },
]
const PROJECTS: Page = { label: 'Projects', path: '/settings/projects' }
/** A project's pages, under Projects once one is open */
const PROJECT: Page[] = [
  { label: 'General', path: 'general' },
  { label: 'Connect', path: 'connect' },
  { label: 'Stack traces', path: 'stack-traces' },
  { label: 'Events', path: 'events' },
  { label: 'Issues', path: 'issues' },
  { label: 'Import from Sentry', path: 'import' },
]
const PERSONAL: Page[] = [
  { label: 'Account', path: '/settings/account' },
  { label: 'Agent tokens', path: '/settings/agent-tokens' },
  { label: 'Appearance', path: '/settings/appearance' },
  { label: 'Preferences', path: '/settings/preferences' },
]

/** The project whose settings the path is, if any */
export function useSettingsProject() {
  const projects = useProjects()
  const slug = useRouterState({ select: (s) => s.location.pathname.match(/^\/settings\/projects\/([^/]+)/)?.[1] })
  return slug ? projects.find((p) => p.slug === decodeURIComponent(slug)) : undefined
}

/** The settings area's frame: the list of pages beside the page (a select over it on a phone). Projects is one page,
 * the list of them; the project open adds its own pages under it */
export function SettingsNav() {
  const path = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') })
  const navigate = useNavigate()
  const project = useSettingsProject()
  // People only for owners
  const { role } = root.useLoaderData()
  const instance = INSTANCE.filter((p) => role === 'owner' || !p.owners)
  const projectPages = project
    ? PROJECT.map((p) => ({ ...p, path: `/settings/projects/${encodeURIComponent(project.slug)}/${p.path}` }))
    : []
  const link = (p: Page, className?: string) => (
    <Link
      key={p.path}
      to={p.path}
      className={cn(
        'rounded-md px-2 py-1.5 text-sm hover:bg-muted',
        path === p.path && 'bg-muted font-medium text-foreground',
        className,
      )}
    >
      {p.label}
    </Link>
  )
  const heading = (label: string) => (
    <p className="truncate px-2 pb-1 text-xs font-medium text-muted-foreground">{label}</p>
  )
  return (
    <>
      <Select value={path} onValueChange={(to) => void navigate({ href: to })}>
        <SelectTrigger className="h-10 w-full @3xl/settings:hidden" aria-label="Settings page">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>crashyard</SelectLabel>
            {instance.map((p) => (
              <SelectItem key={p.path} value={p.path}>
                {p.label}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value={PROJECTS.path}>{PROJECTS.label}</SelectItem>
          {project && (
            <SelectGroup>
              <SelectLabel>{project.name}</SelectLabel>
              {projectPages.map((p) => (
                <SelectItem key={p.path} value={p.path} className="pl-5">
                  {p.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>You</SelectLabel>
            {PERSONAL.map((p) => (
              <SelectItem key={p.path} value={p.path}>
                {p.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <nav className="grid content-start gap-5 @max-3xl/settings:hidden" aria-label="Settings">
        <div className="grid gap-0.5">
          {heading('crashyard')}
          {instance.map((p) => link(p))}
        </div>
        <div className="grid gap-0.5">
          {link(PROJECTS, cn('font-medium', project && 'text-foreground'))}
          {project && (
            <div className="mt-1 ml-2 grid gap-0.5 border-l pl-2">
              {heading(project.name)}
              {projectPages.map((p) => link(p))}
            </div>
          )}
        </div>
        <div className="grid gap-0.5">
          {heading('You')}
          {PERSONAL.map((p) => link(p))}
        </div>
      </nav>
    </>
  )
}

/** The page the path is, for the title and breadcrumbs */
export function pageOf(path: string) {
  const clean = path.replace(/\/$/, '')
  const project = clean.match(/^\/settings\/projects\/[^/]+\/([^/]+)/)?.[1]
  if (project) return PROJECT.find((p) => p.path === project)?.label
  return [...INSTANCE, PROJECTS, ...PERSONAL].find((p) => p.path === clean)?.label
}

/** A heading over a few cards of a page, with an id to link to */
export const Subhead = ({ id, children }: { id: string; children: React.ReactNode }) => (
  <h2 id={id} className="mt-3 scroll-mt-20 text-lg font-semibold tracking-tight">
    {children}
  </h2>
)

/** One line of a check's outcome: a tick when fine, a warning in amber when not */
export function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const Icon = ok ? IconCircleCheck : IconAlertTriangle
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 text-sm',
        ok ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-400',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/** A settings page's section: a title, what it's for, then its fields */
export function SettingsCard({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border p-4 @xl:p-5', className)}>
      <h2 className="font-medium">{title}</h2>
      {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
      {children && <div className="mt-4">{children}</div>}
    </section>
  )
}

/** Where a deployment's own values live */
export const SET_IN_WRANGLER = 'Set in wrangler.local.json. Change it there, then deploy again.'

/** A value the page shows but can't change, with where it's set */
export function ReadOnly({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label>{label}</Label>
      <p className="min-w-0 text-sm break-words">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

/** A field's line under it */
export const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-muted-foreground">{children}</p>
)

/** Runs a save, then says so or says what went wrong, and reloads the page's data */
export function useSave() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const save = async (run: () => Promise<unknown>, done = 'Saved') => {
    setSaving(true)
    try {
      await run()
      toast.success(done)
      await router.invalidate()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That couldn’t be saved. Try again.')
      return false
    } finally {
      setSaving(false)
    }
  }
  return { save, saving }
}

export function SaveButton({ saving, children = 'Save' }: { saving: boolean; children?: React.ReactNode }) {
  return (
    <Button type="submit" disabled={saving} className="max-sm:h-10">
      {children}
    </Button>
  )
}

/** The fields of daily limits and retention, shared with Defaults for new projects */
const LIMIT_FIELDS = [
  {
    name: 'daily_event_quota',
    label: 'Daily event limit',
    min: 0,
    max: 10_000_000,
    hint: 'Past it, SDKs hold events until midnight UTC.',
  },
  { name: 'daily_log_quota', label: 'Daily log limit', min: 0, max: 10_000_000 },
  { name: 'daily_transaction_quota', label: 'Daily transaction limit', min: 0, max: 10_000_000 },
  {
    name: 'event_retention_days',
    label: 'Event retention in days',
    min: 1,
    max: 3650,
    hint: 'Issues are kept as long as their events.',
  },
  { name: 'log_retention_days', label: 'Log retention in days', min: 1, max: 3650 },
] as const

/** A project's daily limits and retention, as named form fields */
export function LimitInputs({ values }: { values: Record<(typeof LIMIT_FIELDS)[number]['name'], number> }) {
  return LIMIT_FIELDS.map((f) => (
    <div key={f.name} className="grid content-start gap-2">
      <Label htmlFor={f.name}>{f.label}</Label>
      <Input
        id={f.name}
        name={f.name}
        type="number"
        min={f.min}
        max={f.max}
        inputMode="numeric"
        defaultValue={values[f.name]}
      />
      {'hint' in f && <Hint>{f.hint}</Hint>}
    </div>
  ))
}
