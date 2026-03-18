/**
 * Parses a relative time string or ISO timestamp into an ISO timestamp.
 * Accepts: "30m", "1h", "2h", "24h", "7d", "1w" or any ISO string.
 * Returns the input unchanged if it doesn't match a relative format.
 */
export function parseTime(val: string | undefined): string | undefined {
  if (!val) return undefined
  const m = val.match(/^(\d+(?:\.\d+)?)(m|h|d|w)$/)
  if (!m) return val
  const n = parseFloat(m[1]!)
  const unit = m[2]!
  const ms = n * ({ m: 60, h: 3600, d: 86400, w: 604800 }[unit]!) * 1000
  return new Date(Date.now() - ms).toISOString()
}
