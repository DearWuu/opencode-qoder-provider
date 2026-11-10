/** Poll interval of the sidebar credits panel. */
export const STATS_POLL_INTERVAL_MS = 15_000

/**
 * Format a credit sum compactly: at most two decimals, trailing zeros removed.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCredits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0"
  return value.toFixed(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
}

/**
 * Human readable age of a timestamp, relative to `nowMs`.
 *
 * @param {string} iso empty string means "no calls yet"
 * @param {number} nowMs
 * @returns {string}
 */
export function formatRelativeTime(iso, nowMs) {
  if (typeof iso !== "string" || iso.length === 0) return "no calls"
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return "no calls"
  const seconds = Math.max(0, Math.floor((nowMs - then) / 1000))
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * The data lines of the credits panel (the title is rendered by the caller).
 *
 * The numbers are locally accumulated consumption read from the call log,
 * never an account balance. One failing poll collapses the panel into a
 * single muted error line so the TUI never shows stale data as current.
 *
 * @param {{ stats: Record<string, any>|undefined, error: string|undefined, nowMs: number }} input
 * @returns {Array<{ tone: "base"|"muted"|"warning", text: string }>}
 */
export function creditsPanelLines(input) {
  if (input.error !== undefined) return [{ tone: "muted", text: `stats unavailable: ${input.error}` }]
  const stats = input.stats
  if (stats === undefined) return [{ tone: "muted", text: "loading credits stats..." }]
  const lastLine = stats.lastAt.length === 0
    ? "Last no calls yet"
    : `Last ${stats.lastModel.length > 0 ? stats.lastModel : "?"} ${formatCredits(stats.lastCredits)} · ${formatRelativeTime(stats.lastAt, input.nowMs)}`
  return [
    { tone: "muted", text: `Spent ${formatCredits(stats.totalCredits)} · ${stats.totalCalls} calls` },
    { tone: "muted", text: `Today ${formatCredits(stats.todayCredits)} · ${stats.todayCalls} calls` },
    { tone: stats.lastError ? "warning" : "muted", text: lastLine },
    { tone: "muted", text: `${stats.models} models · auth ${stats.authenticated ? "ok" : "error"}` },
  ]
}

/**
 * Repeatedly poll an async source on a fixed interval.
 *
 * The first fetch starts immediately; every completion (or failure) schedules
 * the next one. Timers are injectable so tests can advance time without
 * waiting. `stop()` cancels the pending timer and any in-flight completion.
 * Rejections of `fetch` never break the schedule: the source owns its error
 * reporting, this is only a timer loop.
 *
 * @param {{ fetch: () => Promise<unknown>, intervalMs?: number, setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void }} input
 * @returns {{ start: () => void, stop: () => void }}
 */
export function createStatsPoller(input) {
  const intervalMs = input.intervalMs ?? STATS_POLL_INTERVAL_MS
  const setTimer = input.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = input.clearTimer ?? ((id) => clearTimeout(id))

  let timer = undefined
  let stopped = true

  function schedule() {
    if (stopped) return
    timer = setTimer(() => {
      void tick()
    }, intervalMs)
  }

  async function tick() {
    if (stopped) return
    try {
      await input.fetch()
    } catch {
      // The fetch callback reports its own errors; a poller must never throw.
    }
    schedule()
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void tick()
    },
    stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimer(timer)
        timer = undefined
      }
    },
  }
}
