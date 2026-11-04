// Whether a newer crashyard is out: the repo's releases on GitHub, asked once a day (the Cache API keeps the answer),
// against the version this deployment runs. The one request crashyard makes on its own; it sends nothing about you.
import { version } from '../../package.json'

export const REPO = 'marctorrelles/crashyard'
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const DAY = 86_400

/** What the release workflow adds to the notes of a release that changes `symcache/` (.github/workflows/release-please.yml) */
export const BUILDER_NOTE = 'This release changes the SymCache builder.'
/** The build the release workflow attaches to each release, what an update installs (`install.ts`) */
export const BUNDLE = 'crashyard.json.gz'

export type Release = {
  tag_name: string
  html_url: string
  body: string | null
  draft: boolean
  prerelease: boolean
  assets: { name: string; browser_download_url: string; digest?: string | null }[]
}

export type Update = {
  version: string
  current: string
  url: string
  /** A release past this one changes the SymCache builder, whose image only a deploy builds */
  builder: boolean
  /** A new major version, never installed by the daily check */
  major: boolean
  /** Its build and the SHA-256 GitHub keeps of it, null for a release without one */
  bundle: { url: string; digest: string } | null
}

const parts = (v: string) => v.replace(/^v/, '').split(/[.-]/).map(Number)

/** 1.10.0 is newer than 1.9.2: each part as a number */
export const newer = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

/** The newest release past `current`, and what the ones up to it change */
export function pick(releases: Release[], current: string): Update | null {
  const past = releases
    .filter((r) => !r.draft && !r.prerelease && newer(r.tag_name, current))
    .sort((a, b) => (newer(a.tag_name, b.tag_name) ? -1 : 1))
  const latest = past[0]
  if (!latest) return null
  const asset = latest.assets.find((a) => a.name === BUNDLE)
  return {
    version: latest.tag_name.replace(/^v/, ''),
    current,
    url: latest.html_url,
    builder: past.some((r) => r.body?.includes(BUILDER_NOTE)),
    major: parts(latest.tag_name)[0] !== parts(current)[0],
    bundle: asset?.digest ? { url: asset.browser_download_url, digest: asset.digest } : null,
  }
}

/** `fresh`: an owner's Check now, past the day's cached answer (one request; the cache is per Cloudflare location) */
export async function update(fresh = false): Promise<Update | null> {
  try {
    const cache = (caches as unknown as { default: Cache }).default
    if (fresh) await cache.delete(RELEASES)
    let response = await cache.match(RELEASES)
    if (!response) {
      const fresh = await fetch(RELEASES, {
        headers: { 'user-agent': 'crashyard', accept: 'application/vnd.github+json' },
      })
      // A private repo, no release yet or GitHub down: no update, asked again tomorrow
      const releases = fresh.ok ? ((await fresh.json()) as Release[]) : []
      const kept = releases.map(({ tag_name, html_url, body, draft, prerelease, assets }) => ({
        tag_name,
        html_url,
        // Only whether it changes the builder is read from its notes
        body: body?.includes(BUILDER_NOTE) ? BUILDER_NOTE : null,
        draft,
        prerelease,
        assets: assets.map(({ name, browser_download_url, digest }) => ({ name, browser_download_url, digest })),
      }))
      response = new Response(JSON.stringify(kept), {
        headers: {
          'cache-control': `max-age=${DAY}`,
          'content-type': 'application/json',
          'x-checked-at': String(Date.now()),
        },
      })
      await cache.put(RELEASES, response.clone())
    }
    return pick((await response.json()) as Release[], version)
  } catch {
    return null
  }
}

/** When the cached answer was asked of GitHub, null when there's none (or the cache can't be read) */
export async function checkedAt(): Promise<number | null> {
  try {
    const at = (await (caches as unknown as { default: Cache }).default.match(RELEASES))?.headers.get('x-checked-at')
    return at ? Number(at) : null
  } catch {
    return null
  }
}
