import { sumCredits } from "./logger.mjs"

/**
 * Aggregate the local call log into the stable data set of the sidebar panel.
 *
 * Pure function: the caller passes the entries read from the JSONL log and an
 * injectable clock, so no model call and no network access is involved.
 * "Today" is the local calendar day of `now`.
 *
 * Every field is always present and never null: an absent value shows up as
 * `""` or `0`, which keeps the RPC output schema simple to validate.
 *
 * @param {Array<Record<string, any>>} entries call log entries, oldest first
 * @param {{ provider: string, models: number, authenticated: boolean, permissionMode: string, cliVersion?: string, now?: Date }} info
 * @returns {{ provider: string, models: number, authenticated: boolean, permissionMode: string, cliVersion: string, totalCalls: number, totalCredits: number, todayCalls: number, todayCredits: number, lastModel: string, lastCredits: number, lastAt: string, lastError: boolean }}
 */
export function computeQoderStats(entries, info) {
  const now = info.now ?? new Date()
  const todayKey = localDayKey(now)

  let todayCalls = 0
  let todayCredits = 0
  for (const entry of entries) {
    const entryKey = typeof entry?.ts === "string" ? localDayKey(new Date(entry.ts)) : null
    if (entryKey === null || entryKey !== todayKey) continue
    todayCalls += 1
    if (typeof entry.credits === "number" && Number.isFinite(entry.credits)) todayCredits += entry.credits
  }

  const last = entries.length > 0 ? entries[entries.length - 1] : undefined
  return {
    provider: info.provider,
    models: info.models,
    authenticated: info.authenticated,
    permissionMode: info.permissionMode,
    cliVersion: typeof info.cliVersion === "string" ? info.cliVersion : "",
    totalCalls: entries.length,
    totalCredits: sumCredits(entries),
    todayCalls,
    todayCredits,
    lastModel: typeof last?.model === "string" ? last.model : "",
    lastCredits: typeof last?.credits === "number" && Number.isFinite(last.credits) ? last.credits : 0,
    lastAt: typeof last?.ts === "string" ? last.ts : "",
    lastError: last?.isError === true,
  }
}

/**
 * Local calendar day as `YYYY-MM-DD`; null for an invalid date.
 *
 * @param {Date} date
 * @returns {string|null}
 */
function localDayKey(date) {
  if (Number.isNaN(date.getTime())) return null
  const year = `${date.getFullYear()}`.padStart(4, "0")
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${year}-${month}-${day}`
}
