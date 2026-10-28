import { createFileRoute, notFound } from '@tanstack/react-router'
import { getProjectPage } from '@/fns'
import { DebugFiles } from './-debug-files'
import { Source } from './-source'

export const Route = createFileRoute('/settings/projects/$slug/stack-traces')({
  // The debug files, for their list
  loader: async ({ params }) => {
    const data = await getProjectPage({ data: { slug: params.slug } })
    if (!data) throw notFound()
    return data
  },
  component: StackTraces,
})

// What turns a frame into readable code at its line: the repository, then symbols and source maps
function StackTraces() {
  return (
    <>
      <Source />
      <DebugFiles />
    </>
  )
}
