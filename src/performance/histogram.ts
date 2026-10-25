// Durations as a histogram of log-scale buckets (each 20% wider than the last), so percentiles come from counts in
// D1 rather than every duration: p95 is the top of the bucket where 95% of them are reached, within 20%.

export const BUCKETS = 100
const GROWTH = 1.2

/** The bucket a duration (ms) falls in */
export const bucketOf = (ms: number) =>
  ms <= 1 ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms) / Math.log(GROWTH)))

/** The top of a bucket, in ms */
export const bucketTop = (bucket: number) => Math.round(GROWTH ** bucket)

/** A percentile (0–1) from bucket counts: { bucket: count } */
export function percentile(counts: Map<number, number>, q: number): number | null {
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (!total) return null
  let seen = 0
  for (const bucket of [...counts.keys()].sort((a, b) => a - b)) {
    seen += counts.get(bucket)!
    if (seen >= q * total) return bucketTop(bucket)
  }
  return bucketTop(BUCKETS - 1)
}
