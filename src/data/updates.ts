// Whether a newer crashyard is out: the repo's latest GitHub release, asked once a day (the Cache API keeps the answer),
// against the version this deployment runs. The one request crashyard makes on its own; it sends nothing about you.
import { version } from '../../package.json'

const LATEST = 'https://api.github.com/repos/marctorrelles/crashyard/releases/latest'
const DAY = 86_400

/** 1.10.0 is newer than 1.9.2: each part as a number */
export const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.replace(/^v/, '').split(/[.-]/).map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

export async function update(): Promise<{ version: string; current: string; url: string } | null> {
  try {
    const cache = (caches as unknown as { default: Cache }).default
    let response = await cache.match(LATEST)
    if (!response) {
      const fresh = await fetch(LATEST, {
        headers: { 'user-agent': 'crashyard', accept: 'application/vnd.github+json' },
      })
      // A private repo, no release yet or GitHub down: no banner, asked again tomorrow
      response = new Response(fresh.ok ? await fresh.text() : 'null', {
        headers: { 'cache-control': `max-age=${DAY}`, 'content-type': 'application/json' },
      })
      await cache.put(LATEST, response.clone())
    }
    const latest = (await response.json()) as { tag_name?: string; html_url?: string } | null
    return latest?.tag_name && latest.html_url && newer(latest.tag_name, version)
      ? { version: latest.tag_name.replace(/^v/, ''), current: version, url: latest.html_url }
      : null
  } catch {
    return null
  }
}
