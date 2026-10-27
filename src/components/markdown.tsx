import { Fragment } from 'react'

/** Markdown, the little of it a note needs: paragraphs, line breaks, **bold**, links and lists. Nothing else */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n\s*\n/)
  return (
    <div className="grid gap-2 text-sm leading-relaxed">
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        const bullet = /^\s*[-*]\s+/
        const numbered = /^\s*\d+[.)]\s+/
        if (lines.every((l) => bullet.test(l)))
          return (
            <ul key={i} className="list-disc pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(bullet, ''))}</li>
              ))}
            </ul>
          )
        if (lines.every((l) => numbered.test(l)))
          return (
            <ol key={i} className="list-decimal pl-5">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(numbered, ''))}</li>
              ))}
            </ol>
          )
        return (
          <p key={i} className="break-words">
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </div>
  )
}

// **bold** and [links](https://…), the rest as text; a link that isn't http or https stays text
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      m[1] !== undefined ? (
        <strong key={m.index}>{m[1]}</strong>
      ) : (
        <a key={m.index} href={m[3]} target="_blank" rel="noreferrer noopener" className="underline">
          {m[2]}
        </a>
      ),
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
