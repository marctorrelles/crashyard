// Performance for the dashboard: transactions by p95 over a period, how much slower they got since the release
// before, one transaction's hours and examples; crash-free sessions per release; and the slower-release check.
import { percentile } from '../performance/histogram'
import type { Span } from '../performance/ingest'
import type { Notice } from '../notify/notice'

const HOUR = 3_600_000
type Bucket = { name: string; release: string; bucket: number; count: number }

const histograms = <R extends Bucket>(rows: R[], key: (r: R) => string) => {
  const out = new Map<string, Map<number, number>>()
  for (const r of rows) {
    const h = out.get(key(r)) ?? new Map<number, number>()
    h.set(r.bucket, (h.get(r.bucket) ?? 0) + r.count)
    out.set(key(r), h)
  }
  return out
}

/** A project's releases with transactions, newest first (by when they were first seen) */
async function releasesOf(db: D1Database, projectId: number, since: number) {
  return (
    await db
      .prepare(
        "SELECT release FROM transaction_hours WHERE project_id = ? AND hour >= ? AND release != '' GROUP BY release ORDER BY MIN(hour) DESC LIMIT 2",
      )
      .bind(projectId, since)
      .all<{ release: string }>()
  ).results.map((r) => r.release)
}

/** A sparkline's step for a period: an hour in a day, 6 hours in a week, a day beyond */
const stepOf = (days: number) => (days <= 1 ? HOUR : days <= 7 ? 6 * HOUR : 24 * HOUR)

/**
 * A project's transactions over a period by p95, with p50 and p99, the change since the release before, and `trend`,
 * the p95 of each step of the period (`stepOf`, oldest first, null where there were none)
 */
export async function transactions(db: D1Database, projectId: number, days: number, now: number) {
  const since = Math.floor((now - days * 864e5) / HOUR) * HOUR
  const step = stepOf(days)
  const first = since - (since % step)
  const steps = Array.from({ length: Math.floor((now - first) / step) + 1 }, (_, i) => first + i * step)
  const [totals, buckets] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT name, SUM(count) AS count, SUM(errors) AS errors, SUM(sum_ms) AS sum_ms FROM transaction_hours WHERE project_id = ? AND hour >= ? GROUP BY name',
      )
      .bind(projectId, since),
    // `%` reads whole numbers, so a step's start is whole ms however D1 binds them
    db
      .prepare(
        'SELECT name, release, hour - hour % ? AS at, bucket, SUM(count) AS count FROM transaction_buckets WHERE project_id = ? AND hour >= ? GROUP BY name, release, at, bucket',
      )
      .bind(step, projectId, since),
  ])
  const rows = buckets.results as (Bucket & { at: number })[]
  const byName = histograms(rows, (r) => r.name)
  const byRelease = histograms(rows, (r) => `${r.name}\n${r.release}`)
  const byStep = histograms(rows, (r) => `${r.name}\n${r.at}`)
  const [latest, previous] = await releasesOf(db, projectId, since)
  return {
    latest,
    previous,
    transactions: (totals.results as { name: string; count: number; errors: number; sum_ms: number }[])
      .map((t) => {
        const h = byName.get(t.name)!
        const now95 = latest ? percentile(byRelease.get(`${t.name}\n${latest}`) ?? new Map(), 0.95) : null
        const was95 = previous ? percentile(byRelease.get(`${t.name}\n${previous}`) ?? new Map(), 0.95) : null
        return {
          ...t,
          p50: percentile(h, 0.5),
          p95: percentile(h, 0.95),
          p99: percentile(h, 0.99),
          change: now95 && was95 ? now95 / was95 - 1 : null,
          trend: steps.map((at) => percentile(byStep.get(`${t.name}\n${at}`) ?? new Map(), 0.95)),
        }
      })
      .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0)),
  }
}

export async function transaction(db: D1Database, projectId: number, name: string, days: number, now: number) {
  const since = Math.floor((now - days * 864e5) / HOUR) * HOUR
  const [hours, buckets, examples] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        'SELECT hour, SUM(count) AS count, SUM(errors) AS errors FROM transaction_hours WHERE project_id = ? AND name = ? AND hour >= ? GROUP BY hour ORDER BY hour',
      )
      .bind(projectId, name, since),
    db
      .prepare(
        'SELECT hour, release, bucket, SUM(count) AS count FROM transaction_buckets WHERE project_id = ? AND name = ? AND hour >= ? GROUP BY hour, release, bucket',
      )
      .bind(projectId, name, since),
    db
      .prepare(
        `SELECT id, release, environment, timestamp, duration, status, trace_id, spans FROM transaction_examples
         WHERE project_id = ? AND name = ? AND timestamp >= ? ORDER BY duration DESC LIMIT 10`,
      )
      .bind(projectId, name, since),
  ])
  const rows = buckets.results as (Bucket & { hour: number })[]
  const perHour = histograms(rows, (r) => String(r.hour))
  const perRelease = histograms(rows, (r) => r.release)
  const counts = new Map((hours.results as { hour: number; count: number; errors: number }[]).map((h) => [h.hour, h]))
  // Every hour in the period, empty ones too, so the chart's x is time
  const series = Array.from({ length: days * 24 }, (_, i) => since + i * HOUR).map((hour) => ({
    hour,
    count: counts.get(hour)?.count ?? 0,
    errors: counts.get(hour)?.errors ?? 0,
    p95: percentile(perHour.get(String(hour)) ?? new Map(), 0.95),
  }))
  return {
    series,
    releases: [...perRelease].map(([release, h]) => ({
      release,
      count: [...h.values()].reduce((a, b) => a + b, 0),
      p50: percentile(h, 0.5),
      p95: percentile(h, 0.95),
    })),
    examples: (
      examples.results as {
        id: string
        release: string
        environment: string | null
        timestamp: number
        duration: number
        status: string | null
        trace_id: string | null
        spans: string
      }[]
    ).map((e) => ({ ...e, spans: JSON.parse(e.spans) as Span[] })),
  }
}

/** Sessions per release, for crash-free rates */
export async function sessionsByRelease(db: D1Database, projectId: number) {
  const rows = (
    await db
      .prepare(
        `SELECT release, SUM(started) AS started, SUM(crashed) AS crashed, SUM(abnormal) AS abnormal, SUM(errored) AS errored
         FROM sessions_daily WHERE project_id = ? GROUP BY release`,
      )
      .bind(projectId)
      .all<{ release: string; started: number; crashed: number; abnormal: number; errored: number }>()
  ).results
  return new Map(rows.map((r) => [r.release, r]))
}

export const crashFree = (s?: { started: number; crashed: number }) =>
  s && s.started ? 1 - s.crashed / s.started : null

const ENOUGH = 50 // transactions in each release before comparing them
const SLOWER = 1.5 // p95 half again as long

/** Hourly: a transaction whose p95 in a project's newest release is 50% longer than in the release before */
export async function checkSlowerReleases(db: D1Database, origin: string, now: number): Promise<Notice[]> {
  const since = now - 14 * 864e5
  const projects = (
    await db
      .prepare(
        'SELECT DISTINCT p.id, p.slug, p.name FROM projects p JOIN transaction_hours t ON t.project_id = p.id WHERE t.hour >= ?',
      )
      .bind(since)
      .all<Notice['project']>()
  ).results
  const notices: Notice[] = []
  for (const project of projects) {
    const [latest, previous] = await releasesOf(db, project.id, since)
    if (!latest || !previous) continue
    const rows = (
      await db
        .prepare(
          'SELECT name, release, bucket, SUM(count) AS count FROM transaction_buckets WHERE project_id = ? AND hour >= ? AND release IN (?, ?) GROUP BY name, release, bucket',
        )
        .bind(project.id, since, latest, previous)
        .all<Bucket>()
    ).results
    const h = histograms(rows, (r) => `${r.name}\n${r.release}`)
    const names = new Set(rows.map((r) => r.name))
    for (const name of names) {
      const now95 = h.get(`${name}\n${latest}`)
      const was95 = h.get(`${name}\n${previous}`)
      const n = (m?: Map<number, number>) => (m ? [...m.values()].reduce((a, b) => a + b, 0) : 0)
      if (n(now95) < ENOUGH || n(was95) < ENOUGH) continue
      const p = percentile(now95!, 0.95)!
      const before = percentile(was95!, 0.95)!
      if (p < before * SLOWER) continue
      const fresh = await db
        .prepare(
          'INSERT OR IGNORE INTO slower_releases (project_id, name, release, previous, p95, previous_p95, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING name',
        )
        .bind(project.id, name, latest, previous, p, before, now)
        .first()
      if (!fresh) continue
      notices.push({
        kind: 'slower_release',
        project,
        issue: {
          id: 0,
          title: `${name} is slower in ${latest}`,
          culprit: `p95 ${p} ms, was ${before} ms in ${previous}`,
          level: 'warning',
          count: n(now95),
        },
        event: { release: latest, environment: 'production', level: 'warning' },
        url: `${origin}/projects/${encodeURIComponent(project.slug)}/performance/transaction?name=${encodeURIComponent(name)}`,
      })
    }
  }
  return notices
}

/** The daily cron: summaries after 90 days, examples after 30 */
export async function prunePerformance(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM transaction_hours WHERE hour < ?').bind(now - 90 * 864e5),
    db.prepare('DELETE FROM transaction_buckets WHERE hour < ?').bind(now - 90 * 864e5),
    db.prepare('DELETE FROM transaction_examples WHERE timestamp < ?').bind(now - 30 * 864e5),
  ])
}
