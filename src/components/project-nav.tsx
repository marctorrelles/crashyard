// A project's tabs: its issues, releases and settings.
import { Link } from '@tanstack/react-router'

const TAB =
  'border-b-2 border-transparent px-1 pb-2 text-sm text-muted-foreground hover:text-foreground data-[status=active]:border-foreground data-[status=active]:text-foreground'

export function ProjectNav({ slug }: { slug: string }) {
  return (
    <nav className="-mt-2 mb-5 flex gap-5 border-b" aria-label="Project">
      <Link to="/issues" search={{ project: slug }} className={TAB} activeOptions={{ includeSearch: false }}>
        Issues
      </Link>
      <Link to="/projects/$slug/releases" params={{ slug }} className={TAB} activeOptions={{ exact: false }}>
        Releases
      </Link>
      <Link to="/projects/$slug/settings" params={{ slug }} className={TAB}>
        Settings
      </Link>
    </nav>
  )
}
