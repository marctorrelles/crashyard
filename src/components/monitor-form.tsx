// Adding or changing a monitor: an uptime check (a URL the worker checks) or a cron monitor (a job that checks in).
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { saveMonitor } from '@/fns'

type Project = { id: number; slug: string; name: string }
export type Editing = {
  id?: number
  kind: 'uptime' | 'cron'
  project_id?: number
  name?: string
  slug?: string
  environment?: string
  failure_threshold?: number
  recovery_threshold?: number
  config?: Record<string, unknown>
}

function Field({
  id,
  label,
  hint,
  ...props
}: { id: string; label: string; hint?: string } & React.ComponentProps<'input'>) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={`m-${id}`}>{label}</Label>
      <Input id={`m-${id}`} name={id} autoComplete="off" {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function MonitorForm({
  editing,
  projects,
  onClose,
}: {
  editing: Editing
  projects: Project[]
  onClose: () => void
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const c = (editing.config ?? {}) as Record<string, unknown>
  const schedule = (c.schedule ?? { type: 'crontab', value: '0 * * * *' }) as {
    type: string
    value: string | number
    unit?: string
  }
  const [project, setProject] = useState(String(editing.project_id ?? projects[0]?.id ?? ''))
  const [scheduleType, setScheduleType] = useState(schedule.type)
  const [unit, setUnit] = useState(schedule.unit ?? 'hour')
  const [method, setMethod] = useState(String(c.method ?? 'GET'))
  const uptime = editing.kind === 'uptime'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
            const num = (v: string) => (v ? Number(v) : undefined)
            const config = uptime
              ? {
                  url: f.url,
                  method,
                  expectedStatus: num(f.expectedStatus),
                  mustContain: f.mustContain || undefined,
                  intervalMinutes: num(f.intervalMinutes),
                  timeoutMs: num(f.timeoutSeconds) && num(f.timeoutSeconds)! * 1000,
                }
              : {
                  schedule:
                    scheduleType === 'interval'
                      ? { type: 'interval', value: num(f.every), unit }
                      : { type: 'crontab', value: f.crontab },
                  timezone: f.timezone || undefined,
                  checkinMargin: num(f.checkinMargin),
                  maxRuntime: num(f.maxRuntime),
                }
            try {
              const id = await saveMonitor({
                data: {
                  id: editing.id,
                  kind: editing.kind,
                  project_id: Number(project),
                  name: f.name,
                  slug: f.slug,
                  environment: f.environment,
                  failure_threshold: num(f.failure_threshold),
                  recovery_threshold: num(f.recovery_threshold),
                  config,
                },
              })
              onClose()
              if (editing.id) await router.invalidate()
              else await navigate({ to: '/monitors/$monitorId', params: { monitorId: String(id) } })
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'Not saved')
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing.id ? 'Edit' : 'Add'} {uptime ? 'an uptime check' : 'a cron monitor'}
            </DialogTitle>
            <DialogDescription>
              {uptime
                ? 'crashyard asks the URL every few minutes, and tells your routes when it stops answering as it should.'
                : 'A scheduled job checks in when it runs (Sentry.captureCheckIn, or sentry-cli monitors run). A run that’s missed, fails or takes too long opens an incident.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="m-project">Project</Label>
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger id="m-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field
              id="name"
              label="Name"
              defaultValue={editing.name}
              required
              placeholder={uptime ? 'Sync server' : 'Nightly backup'}
            />
            {uptime ? (
              <>
                <Field
                  id="url"
                  label="URL"
                  type="url"
                  defaultValue={String(c.url ?? '')}
                  required
                  placeholder="https://api.example.com/health"
                />
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="m-method">Method</Label>
                    <Select value={method} onValueChange={setMethod}>
                      <SelectTrigger id="m-method" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {['GET', 'HEAD', 'POST'].map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Field
                    id="expectedStatus"
                    label="Status"
                    type="number"
                    inputMode="numeric"
                    defaultValue={c.expectedStatus as number | undefined}
                    placeholder="any 2xx"
                  />
                </div>
                <Field
                  id="mustContain"
                  label="The page must say"
                  defaultValue={c.mustContain as string | undefined}
                  placeholder="(optional)"
                />
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    id="intervalMinutes"
                    label="Every (minutes)"
                    type="number"
                    min={1}
                    max={60}
                    defaultValue={(c.intervalMinutes as number) ?? 5}
                  />
                  <Field
                    id="timeoutSeconds"
                    label="Timeout (seconds)"
                    type="number"
                    min={1}
                    max={30}
                    defaultValue={c.timeoutMs ? Number(c.timeoutMs) / 1000 : 10}
                  />
                </div>
              </>
            ) : (
              <>
                <Field
                  id="slug"
                  label="Slug"
                  defaultValue={editing.slug}
                  disabled={!!editing.id}
                  hint="What the job checks in with (monitorSlug). Empty: made from the name."
                />
                <div className="grid gap-2">
                  <Label htmlFor="m-schedule">Schedule</Label>
                  <Select value={scheduleType} onValueChange={setScheduleType}>
                    <SelectTrigger id="m-schedule" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="crontab">Crontab</SelectItem>
                      <SelectItem value="interval">Every so often</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {scheduleType === 'crontab' ? (
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      id="crontab"
                      label="Crontab"
                      defaultValue={schedule.type === 'crontab' ? String(schedule.value) : '0 * * * *'}
                      required
                      className="font-mono"
                    />
                    <Field
                      id="timezone"
                      label="Time zone"
                      defaultValue={(c.timezone as string) ?? 'UTC'}
                      placeholder="Europe/Madrid"
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      id="every"
                      label="Every"
                      type="number"
                      min={1}
                      defaultValue={schedule.type === 'interval' ? Number(schedule.value) : 1}
                    />
                    <div className="grid gap-2">
                      <Label htmlFor="m-unit">Unit</Label>
                      <Select value={unit} onValueChange={setUnit}>
                        <SelectTrigger id="m-unit" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {['minute', 'hour', 'day', 'week', 'month'].map((u) => (
                            <SelectItem key={u} value={u}>
                              {u}s
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    id="checkinMargin"
                    label="Late after (minutes)"
                    type="number"
                    min={1}
                    defaultValue={(c.checkinMargin as number) ?? 1}
                  />
                  <Field
                    id="maxRuntime"
                    label="Runs at most (minutes)"
                    type="number"
                    min={1}
                    defaultValue={(c.maxRuntime as number) ?? 30}
                  />
                </div>
              </>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field id="environment" label="Environment" defaultValue={editing.environment ?? 'production'} />
              <Field
                id="failure_threshold"
                label="Fails in a row"
                type="number"
                min={1}
                defaultValue={editing.failure_threshold ?? (uptime ? 2 : 1)}
              />
              <Field
                id="recovery_threshold"
                label="Back after"
                type="number"
                min={1}
                defaultValue={editing.recovery_threshold ?? 1}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
