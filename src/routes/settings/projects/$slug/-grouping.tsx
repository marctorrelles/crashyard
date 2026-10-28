import { getRouteApi } from '@tanstack/react-router'
import { IconCircleCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { Hint, SaveButton, SettingsCard, useSave } from '@/components/settings'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { updateProject } from '@/fns'
import { parseGroupingRules } from '@/ingest/rules'

const parent = getRouteApi('/settings/projects/$slug')

const EXAMPLE = `# Every timeout is one issue
error.type:TimeoutError -> timeouts
# Frames from vendored code aren't the app's
stack.module:Vendor* -app`

export function Grouping() {
  const { project } = parent.useLoaderData()
  const { save, saving } = useSave()
  const [rules, setRules] = useState(project.grouping_rules ?? '')
  const [check, setCheck] = useState<{ ok: true; count: number } | { ok: false; text: string } | null>(null)
  const validate = () => {
    const parsed = parseGroupingRules(rules)
    setCheck(
      'error' in parsed
        ? { ok: false, text: `Line ${parsed.line}: ${parsed.error}` }
        : { ok: true, count: parsed.fingerprint.length + parsed.stack.length },
    )
  }
  return (
    <SettingsCard
      title="Grouping rules"
      description={
        <>
          Decide which events become one issue. Fingerprint rules give matching events their own fingerprint. Stack
          trace rules choose which frames are the app’s and which count for grouping. They follow Sentry’s{' '}
          <a
            className="underline"
            href="https://docs.sentry.io/concepts/data-management/event-grouping/fingerprint-rules/"
            target="_blank"
            rel="noreferrer"
          >
            fingerprint rules
          </a>{' '}
          and{' '}
          <a
            className="underline"
            href="https://docs.sentry.io/concepts/data-management/event-grouping/stack-trace-rules/"
            target="_blank"
            rel="noreferrer"
          >
            stack trace rules
          </a>
          .
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save(() => updateProject({ data: { id: project.id, grouping_rules: rules } }))
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="rules">Rules, one a line</Label>
          <Textarea
            id="rules"
            value={rules}
            onChange={(e) => {
              setRules(e.target.value)
              setCheck(null)
            }}
            placeholder={EXAMPLE}
            rows={10}
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Hint>
            Matchers are error.type, error.value, message, level, tags.name, stack.function, stack.module,
            stack.abs_path, stack.package, app and family. Actions are +app, -app, +group and -group. Lines starting
            with # are notes.
          </Hint>
          {check &&
            (check.ok ? (
              <p className="flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
                <IconCircleCheck className="size-4" />
                {check.count === 1 ? 'One rule, all good.' : `${check.count} rules, all good.`}
              </p>
            ) : (
              <p className="text-sm text-destructive" role="alert">
                {check.text}
              </p>
            ))}
        </div>
        <Hint>New events follow the rules within a minute. Issues already made keep their events.</Hint>
        <div className="flex flex-wrap gap-2">
          <SaveButton saving={saving} />
          <Button type="button" variant="outline" className="max-sm:h-10" onClick={validate}>
            Check rules
          </Button>
        </div>
      </form>
    </SettingsCard>
  )
}
