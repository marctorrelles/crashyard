// Adding or changing a monitor: an uptime check (a URL the worker checks) or a cron monitor (a job that checks in).
import { useNavigate, useRouter } from '@tanstack/react-router'
import { IconPlus, IconX } from '@tabler/icons-react'
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
import { Textarea } from '@/components/ui/textarea'
import { saveMonitor } from '@/fns'
import { type Assertion, BODY_METHODS, UPTIME_METHODS } from '@/monitors/monitors'

type Row = { key: number; name: string; value: string }
type AssertionRow = { key: number; kind: Assertion['kind']; a: string; b: string }
let nextKey = 0
const rowsOf = (headers: unknown): Row[] =>
  Array.isArray(headers) ? headers.map(([name, value]) => ({ key: nextKey++, name, value })) : []
const assertionRowsOf = (list: unknown): AssertionRow[] =>
  Array.isArray(list)
    ? (list as Assertion[]).map((a) => ({
        key: nextKey++,
        kind: a.kind,
        a: a.kind === 'status' ? a.in.join(', ') : a.kind === 'header' ? a.name : a.path,
        b: a.kind === 'header' ? a.contains : a.kind === 'json' ? a.equals : '',
      }))
    : []
const assertionOf = (r: AssertionRow): Assertion =>
  r.kind === 'status'
    ? {
        kind: 'status',
        in: r.a
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number),
      }
    : r.kind === 'header'
      ? { kind: 'header', name: r.a.trim(), contains: r.b }
      : { kind: 'json', path: r.a.trim(), equals: r.b }
const ASSERTION_LABELS: Record<Assertion['kind'], [string, string, string, string]> = {
  status: ['Status is one of', '200, 204', '', ''],
  header: ['Header contains', 'content-type', 'Contains', 'json'],
  json: ['JSON path equals', '$.status', 'Equals', 'ok'],
}

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
  const [headers, setHeaders] = useState<Row[]>(() => rowsOf(c.headers))
  const [assertions, setAssertions] = useState<AssertionRow[]>(() => assertionRowsOf(c.assertions))
  const uptime = editing.kind === 'uptime'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={`max-h-[90dvh] overflow-y-auto${uptime ? ' sm:max-w-2xl' : ''}`}>
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
                  headers: headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]),
                  body: BODY_METHODS.has(method) ? f.body || undefined : undefined,
                  assertions: assertions.filter((a) => a.a.trim()).map(assertionOf),
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
              toast.error(error instanceof Error ? error.message : 'The monitor couldn’t be saved')
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing.id ? 'Edit' : 'Add'} {uptime ? 'uptime check' : 'cron monitor'}
            </DialogTitle>
            <DialogDescription>
              {uptime
                ? 'crashyard requests the URL on a schedule and notifies you when it stops answering as expected.'
                : 'A scheduled job checks in each time it runs, through Sentry.captureCheckIn or sentry-cli monitors run. A missed, failed or overlong run opens an incident.'}
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
              maxLength={100}
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
                        {UPTIME_METHODS.map((m) => (
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
                    min={100}
                    max={599}
                    inputMode="numeric"
                    defaultValue={c.expectedStatus as number | undefined}
                    placeholder="Any 2xx"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Headers</Label>
                  {headers.map((h, i) => (
                    <div key={h.key} className="flex gap-2">
                      <Input
                        aria-label="Header name"
                        placeholder="Authorization"
                        value={h.name}
                        onChange={(e) => setHeaders(headers.with(i, { ...h, name: e.target.value }))}
                        className="w-2/5"
                      />
                      <Input
                        aria-label="Header value"
                        placeholder="Bearer …"
                        value={h.value}
                        onChange={(e) => setHeaders(headers.with(i, { ...h, value: e.target.value }))}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove header"
                        onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                      >
                        <IconX />
                      </Button>
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setHeaders([...headers, { key: nextKey++, name: '', value: '' }])}
                    >
                      <IconPlus data-icon="inline-start" />
                      Add header
                    </Button>
                  </div>
                </div>
                {BODY_METHODS.has(method) && (
                  <div className="grid gap-2">
                    <Label htmlFor="m-body">Body</Label>
                    <Textarea
                      id="m-body"
                      name="body"
                      rows={3}
                      defaultValue={String(c.body ?? '')}
                      placeholder='{"ping": true}'
                      className="font-mono text-xs"
                    />
                  </div>
                )}
                <Field
                  id="mustContain"
                  label="Response must contain"
                  maxLength={200}
                  defaultValue={c.mustContain as string | undefined}
                  placeholder="Optional"
                />
                <div className="grid gap-2">
                  <Label>Assertions</Label>
                  <p className="-mt-1 text-xs text-muted-foreground">
                    Every one must hold for the check to pass. A status assertion replaces the status above.
                  </p>
                  {assertions.map((r, i) => {
                    const [, aHint, bLabel, bHint] = ASSERTION_LABELS[r.kind]
                    return (
                      <div
                        key={r.key}
                        className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border p-2 sm:grid-cols-[10rem_1fr_1fr_auto]"
                      >
                        <Select
                          value={r.kind}
                          onValueChange={(v) =>
                            setAssertions(assertions.with(i, { ...r, kind: v as Assertion['kind'] }))
                          }
                        >
                          <SelectTrigger aria-label="Kind of assertion" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(ASSERTION_LABELS).map(([kind, [label]]) => (
                              <SelectItem key={kind} value={kind}>
                                {label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          aria-label={ASSERTION_LABELS[r.kind][0]}
                          placeholder={aHint}
                          value={r.a}
                          onChange={(e) => setAssertions(assertions.with(i, { ...r, a: e.target.value }))}
                          className={r.kind === 'json' ? 'font-mono max-sm:col-span-2' : 'max-sm:col-span-2'}
                        />
                        {r.kind === 'status' ? (
                          <p className="self-center text-xs text-muted-foreground max-sm:col-span-2">
                            Status codes separated by commas, such as 200, 204.
                          </p>
                        ) : (
                          <Input
                            aria-label={bLabel}
                            placeholder={bHint}
                            value={r.b}
                            onChange={(e) => setAssertions(assertions.with(i, { ...r, b: e.target.value }))}
                            className="max-sm:col-span-2"
                          />
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label="Remove assertion"
                          className="max-sm:col-start-2 max-sm:row-start-1"
                          onClick={() => setAssertions(assertions.filter((_, j) => j !== i))}
                        >
                          <IconX />
                        </Button>
                      </div>
                    )
                  })}
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAssertions([...assertions, { key: nextKey++, kind: 'status', a: '', b: '' }])}
                    >
                      <IconPlus data-icon="inline-start" />
                      Add assertion
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    id="intervalMinutes"
                    label="Interval in minutes"
                    type="number"
                    min={1}
                    max={60}
                    defaultValue={(c.intervalMinutes as number) ?? 5}
                  />
                  <Field
                    id="timeoutSeconds"
                    label="Timeout in seconds"
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
                  maxLength={100}
                  defaultValue={editing.slug}
                  disabled={!!editing.id}
                  hint="The monitorSlug the job checks in with. Leave it empty to derive it from the name."
                />
                <div className="grid gap-2">
                  <Label htmlFor="m-schedule">Schedule</Label>
                  <Select value={scheduleType} onValueChange={setScheduleType}>
                    <SelectTrigger id="m-schedule" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="crontab">Crontab</SelectItem>
                      <SelectItem value="interval">Interval</SelectItem>
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
                      max={1000}
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
                    label="Grace period in minutes"
                    type="number"
                    min={1}
                    max={1440}
                    defaultValue={(c.checkinMargin as number) ?? 1}
                  />
                  <Field
                    id="maxRuntime"
                    label="Maximum runtime in minutes"
                    type="number"
                    min={1}
                    max={1440}
                    defaultValue={(c.maxRuntime as number) ?? 30}
                  />
                </div>
              </>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field
                id="environment"
                label="Environment"
                maxLength={64}
                defaultValue={editing.environment ?? 'production'}
              />
              <Field
                id="failure_threshold"
                label="Failures before an incident"
                type="number"
                min={1}
                max={100}
                defaultValue={editing.failure_threshold ?? (uptime ? 2 : 1)}
              />
              <Field
                id="recovery_threshold"
                label="Successes to recover"
                type="number"
                min={1}
                max={100}
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
