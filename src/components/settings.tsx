// The settings area's pieces: its pages in three groups (the deployment's, the project's, the viewer's own), the left
// list (a select on a phone), and what each page is made of.
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router'
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
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

type Page = { label: string; path: string }
type Group = { label: string; pages: Page[] }

const INSTANCE: Page[] = [
  { label: 'General', path: '/settings/general' },
  { label: 'Email', path: '/settings/email' },
  { label: 'New-project defaults', path: '/settings/defaults' },
  { label: 'Data privacy', path: '/settings/privacy' },
  { label: 'Tokens', path: '/settings/tokens' },
  { label: 'Usage', path: '/settings/usage' },
  { label: 'Health', path: '/settings/health' },
  { label: 'About', path: '/settings/about' },
]
const PROJECT: Page[] = [
  { label: 'General', path: 'general' },
  { label: 'Issues', path: 'issues' },
  { label: 'Grouping', path: 'grouping' },
  { label: 'Client keys', path: 'keys' },
  { label: 'Limits and retention', path: 'limits' },
  { label: 'Source code', path: 'source' },
  { label: 'Connect an app', path: 'connect' },
  { label: 'Debug files', path: 'debug-files' },
  { label: 'Delete project', path: 'delete' },
]
const PERSONAL: Page[] = [
  { label: 'Appearance', path: '/settings/appearance' },
  { label: 'Date and time', path: '/settings/date-and-time' },
  { label: 'Stack traces', path: '/settings/stack-traces' },
  { label: 'Home', path: '/settings/home' },
]

/** The groups, the project's for `slug` (the page's, else the one picked last, else the first) */
function groupsFor(project?: { slug: string; name: string }): Group[] {
  return [
    { label: 'crashyard', pages: INSTANCE },
    ...(project
      ? [
          {
            label: project.name,
            pages: PROJECT.map((p) => ({ ...p, path: `/settings/projects/${project.slug}/${p.path}` })),
          },
        ]
      : []),
    { label: 'You', pages: PERSONAL },
  ]
}

/** The settings area's frame: the list of pages beside the page (a select over it on a phone) */
export function SettingsNav({ lastProject }: { lastProject: string | null }) {
  const projects = useProjects()
  const path = useRouterState({ select: (s) => s.location.pathname.replace(/\/$/, '') })
  const navigate = useNavigate()
  const slug = path.match(/^\/settings\/projects\/([^/]+)/)?.[1]
  const project =
    projects.find((p) => p.slug === (slug ? decodeURIComponent(slug) : lastProject)) ?? (slug ? undefined : projects[0])
  const groups = groupsFor(project)
  return (
    <>
      <div className="md:hidden">
        <Select value={path} onValueChange={(to) => void navigate({ href: to })}>
          <SelectTrigger className="h-10 w-full" aria-label="Settings page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <SelectGroup key={g.label}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.pages.map((p) => (
                  <SelectItem key={p.path} value={p.path}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <nav className="grid content-start gap-5 max-md:hidden" aria-label="Settings">
        {groups.map((g) => (
          <div key={g.label} className="grid gap-0.5">
            <p className="truncate px-2 pb-1 text-xs font-medium text-muted-foreground">{g.label}</p>
            {g.pages.map((p) => (
              <Link
                key={p.path}
                to={p.path}
                className={cn(
                  'rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                  path === p.path && 'bg-muted font-medium text-foreground',
                )}
              >
                {p.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
    </>
  )
}

/** The page the path is, for the breadcrumbs */
export function pageOf(path: string) {
  const clean = path.replace(/\/$/, '')
  const project = clean.match(/^\/settings\/projects\/[^/]+\/([^/]+)/)?.[1]
  if (project) return PROJECT.find((p) => p.path === project)?.label
  return [...INSTANCE, ...PERSONAL].find((p) => p.path === clean)?.label
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
    <section className={cn('min-w-0 rounded-xl border p-4 sm:p-5', className)}>
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

/** The fields of daily limits and retention, shared with New-project defaults */
const LIMIT_FIELDS = [
  {
    name: 'daily_event_quota',
    label: 'Daily event limit',
    min: 0,
    hint: 'Past it, SDKs hold events until midnight UTC.',
  },
  { name: 'daily_log_quota', label: 'Daily log limit', min: 0 },
  { name: 'daily_transaction_quota', label: 'Daily transaction limit', min: 0 },
  {
    name: 'event_retention_days',
    label: 'Event retention in days',
    min: 1,
    hint: 'Issues are kept as long as their events.',
  },
  { name: 'log_retention_days', label: 'Log retention in days', min: 1 },
] as const

/** A project's daily limits and retention, as named form fields */
export function LimitInputs({ values }: { values: Record<(typeof LIMIT_FIELDS)[number]['name'], number> }) {
  return LIMIT_FIELDS.map((f) => (
    <div key={f.name} className="grid content-start gap-2">
      <Label htmlFor={f.name}>{f.label}</Label>
      <Input id={f.name} name={f.name} type="number" min={f.min} inputMode="numeric" defaultValue={values[f.name]} />
      {'hint' in f && <Hint>{f.hint}</Hint>}
    </div>
  ))
}
