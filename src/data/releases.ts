// Releases: a project's releases from its events, and what one changed against the one before (the release diff).

export type ReleaseRow = { release: string; events: number; issues: number; first: number; last: number }

// ponytail: read from events (kept 90 days), so older releases drop off; a releases table comes with uploads (phase 5)
export async function listReleases(db: D1Database, projectId: number) {
  return (
    await db
      .prepare(
        `SELECT release, COUNT(*) AS events, COUNT(DISTINCT issue_id) AS issues, MIN(received) AS first, MAX(received) AS last
         FROM events WHERE project_id = ? AND release IS NOT NULL GROUP BY release ORDER BY first DESC LIMIT 100`,
      )
      .bind(projectId)
      .all<ReleaseRow>()
  ).results
}

type DiffIssue = { id: number; title: string; culprit: string; level: string; status: string; count: number }

/** New, regressed, still happening, and gone (seen in the release before, not in this one) */
export async function releaseDiff(db: D1Database, projectId: number, release: string) {
  const releases = await listReleases(db, projectId)
  const at = releases.findIndex((r) => r.release === release)
  if (at < 0) return null
  const previous = releases[at + 1]?.release ?? null
  const inRelease = (r: string) =>
    `EXISTS (SELECT 1 FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = 'release' AND v.value = ${r})`
  const cols = `i.id, i.title, i.culprit, i.level, i.status,
    (SELECT count FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = 'release' AND v.value = ?1) AS count`
  const [fresh, regressed, ongoing, gone] = await db.batch<DiffIssue>([
    db
      .prepare(`SELECT ${cols} FROM issues i WHERE i.project_id = ?2 AND i.first_release = ?1 ORDER BY count DESC`)
      .bind(release, projectId),
    db
      .prepare(
        `SELECT ${cols} FROM issues i WHERE i.project_id = ?2 AND i.id IN (SELECT issue_id FROM issue_activity
           WHERE kind = 'regressed' AND json_extract(data, '$.release') = ?1) ORDER BY count DESC`,
      )
      .bind(release, projectId),
    db
      .prepare(
        `SELECT ${cols} FROM issues i WHERE i.project_id = ?2 AND ${inRelease('?1')} AND i.first_release IS NOT ?1
           AND i.id NOT IN (SELECT issue_id FROM issue_activity WHERE kind = 'regressed' AND json_extract(data, '$.release') = ?1)
         ORDER BY count DESC LIMIT 50`,
      )
      .bind(release, projectId),
    db
      .prepare(
        `SELECT i.id, i.title, i.culprit, i.level, i.status,
           (SELECT count FROM issue_tag_values v WHERE v.issue_id = i.id AND v.key = 'release' AND v.value = ?3) AS count
         FROM issues i WHERE i.project_id = ?2 AND ${inRelease('?3')} AND NOT ${inRelease('?1')} ORDER BY count DESC LIMIT 50`,
      )
      .bind(release, projectId, previous),
  ])
  return {
    release: releases[at],
    previous,
    fresh: fresh.results,
    regressed: regressed.results,
    ongoing: ongoing.results,
    gone: previous ? gone.results : [],
  }
}
