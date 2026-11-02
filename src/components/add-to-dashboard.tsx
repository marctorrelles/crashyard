// "Add to dashboard": a chart as a widget at the end of a dashboard picked from the list, from the logs and analytics
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
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
import type { Widget } from '@/data/widgets'
import { addWidget, getDashboards } from '@/fns'

/** "Add to dashboard": the chart as a widget at the end of a dashboard picked from the list */
export function AddToDashboard({
  widget,
  onClose,
  description = 'The chart joins the end of the dashboard, with this search.',
}: {
  widget: Widget
  onClose: () => void
  description?: string
}) {
  const [list, setList] = useState<{ id: number; name: string }[] | null>(null)
  const [id, setId] = useState<string>('')
  const [title, setTitle] = useState(widget.title)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void getDashboards().then((d) => {
      if (!live) return
      setList(d.dashboards)
      setId(d.dashboards[0] ? String(d.dashboards[0].id) : '')
    })
    return () => {
      live = false
    }
  }, [])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              await addWidget({ data: { id: Number(id), widget: { ...widget, title: title.trim() || widget.title } } })
              toast.success(`Added to ${list?.find((d) => String(d.id) === id)?.name ?? 'the dashboard'}`)
              onClose()
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'The widget couldn’t be added')
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Add to dashboard</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {list !== null && list.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No dashboards yet.{' '}
              <Link to="/dashboards" className="underline">
                Create one
              </Link>{' '}
              first.
            </p>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="add-dashboard">Dashboard</Label>
                <Select value={id} onValueChange={setId} disabled={list === null}>
                  <SelectTrigger id="add-dashboard" className="w-full">
                    <SelectValue placeholder="Loading…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(list ?? []).map((d) => (
                      <SelectItem key={d.id} value={String(d.id)}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="add-title">Title</Label>
                <Input
                  id="add-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={80}
                  required
                />
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !id}>
              Add to dashboard
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
