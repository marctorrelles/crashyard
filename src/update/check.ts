// Whether a newer crashyard is out: the repo's releases on GitHub, asked once a day (the Cache API keeps the answer),
// against the version this deployment runs. The one request crashyard makes on its own; it sends nothing about you.
import { version } from '../../package.json'

export const REPO = 'marctorrelles/crashyard'
/**
 * Every release, as the release workflow attaches it to the newest (.github/workflows/release-please.yml). A release
 * file, not GitHub's API: the API allows 60 unsigned requests an hour per address, which Workers share
 */
const MANIFEST = 'releases.json'
const RELEASES = `https://github.com/${REPO}/releases/latest/download/${MANIFEST}`
const DAY = 86_400
const HOUR = 3_600

/** What the release workflow adds to the notes of a release that changes `symcache/` (.github/workflows/release-please.yml) */
export const BUILDER_NOTE = 'This release changes the SymCache builder.'
/** The build the release workflow attaches to each release, what an update installs (`install.ts`) */
export const BUNDLE = 'crashyard.json.gz'

/** One release in `MANIFEST`, its notes only as `BUILDER_NOTE` when they carry it */
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

/** What GitHub was last asked: the newest release past this version, and when it said so, null when it couldn't be asked */
export type Checked = { update: Update | null; checkedAt: number | null }

/** Check now's refusal when GitHub doesn't answer: the answer kept stays */
export const UNREACHABLE = 'GitHub didn’t answer. Try again in a few minutes.'

/**
 * The day's answer, kept through the Cache API (per Cloudflare location). `fresh`, an owner's Check now: GitHub asked
 * again, the answer kept replaced only by a newer one, else `UNREACHABLE` thrown. Without it, never throws
 */
export async function latest(fresh = false): Promise<Checked> {
  try {
    const cache = (caches as unknown as { default: Cache }).default
    let response = fresh ? undefined : await cache.match(RELEASES)
    if (!response) {
      const asked = await fetch(RELEASES, {
        cache: 'no-store',
        headers: { 'user-agent': 'crashyard' },
      }).catch(() => null)
      if (!asked?.ok && fresh) throw new Error(UNREACHABLE)
      // GitHub down, or the newest release without its manifest yet (the workflow attaches it after the build): no
      // update and no time it was checked, asked again in an hour
      const releases = asked?.ok ? ((await asked.json()) as Release[]) : []
      response = new Response(JSON.stringify(releases), {
        headers: {
          'cache-control': `max-age=${asked?.ok ? DAY : HOUR}`,
          'content-type': 'application/json',
          ...(asked?.ok && { 'x-checked-at': String(Date.now()) }),
        },
      })
      await cache.put(RELEASES, response.clone())
    }
    const at = response.headers.get('x-checked-at')
    return { update: pick((await response.json()) as Release[], version), checkedAt: at ? Number(at) : null }
  } catch (error) {
    if (fresh) throw new Error(UNREACHABLE, { cause: error })
    return { update: null, checkedAt: null }
  }
}

/** The newest release past this version, from the day's answer */
export const update = async () => (await latest()).update
