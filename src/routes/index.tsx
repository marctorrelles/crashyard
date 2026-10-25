import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-2 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">crashyard</h1>
      <p className="text-muted-foreground">No projects yet.</p>
    </main>
  )
}
