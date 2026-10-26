// "New project": a name and a platform, then its settings page with the DSN and how to link the app.
import { useNavigate } from '@tanstack/react-router'
import { IconPlus } from '@tabler/icons-react'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createProject } from '@/fns'

export const PLATFORM_NAMES = {
  apple: 'Apple (Swift)',
  android: 'Android (Kotlin)',
  javascript: 'Browser (JavaScript)',
  node: 'Node',
  other: 'Other',
} as const

export function NewProject({ variant = 'default' }: { variant?: 'default' | 'outline' }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [platform, setPlatform] = useState<keyof typeof PLATFORM_NAMES>('apple')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant}>
          <IconPlus data-icon="inline-start" />
          New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="contents"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              const name = String(new FormData(e.currentTarget).get('name'))
              const project = await createProject({ data: { name, platform } })
              setOpen(false)
              await navigate({ to: '/projects/$slug/settings', params: { slug: project.slug } })
            } catch (error) {
              toast.error(error instanceof Error ? error.message : 'The project could not be made')
            } finally {
              setBusy(false)
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>One per app. Its page shows the DSN to put in the app.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" name="name" required maxLength={80} placeholder="pocketband" autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-platform">Platform</Label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as typeof platform)}>
              <SelectTrigger id="project-platform" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PLATFORM_NAMES).map(([value, name]) => (
                  <SelectItem key={value} value={value}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
