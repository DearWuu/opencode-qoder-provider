/**
 * 文件职责：Credits 面板的纯格式化：数值、相对时间、面板行（含错误/加载态）。
 * 上游：panel.tsx 渲染面板行、src/quota 的 status 文案、test/credits.test.ts。
 * 下游：无（纯函数）。
 */

/** 官方额度与本地消耗共用的千分位数值格式。 */
export function formatQuotaNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0"
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

/**
 * Today Credits 固定保留两位小数。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatCredits(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0.00"
  return value.toFixed(2)
}

/**
 * 时间戳相对 `nowMs` 的可读年龄。
 *
 * @param {string} iso 空串表示"还没有调用"
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
 * Credits 面板的数据行（标题由调用方渲染）。
 *
 * Today 来自本地日志；其余两行只展示官方 `/usage` 返回的额度。
 * 配额不可用时不沿用旧数字，也不显示 schema 中的零值占位。
 *
 * 调用方：panel.tsx（经 createMemo 渲染面板行）。
 *
 * @param {{ stats: Record<string, any>|undefined, quota: Record<string, any>|undefined,
 *   error: string|undefined, quotaError?: string|undefined, nowMs: number }} input
 * @returns {Array<{ tone: "base"|"muted"|"warning", text: string }>}
 */
export function creditsPanelLines(input) {
  if (input.error !== undefined) return [{ tone: "muted", text: `stats unavailable: ${input.error}` }]
  if (input.stats === undefined) return [{ tone: "muted", text: "loading credits stats..." }]
  const lines = [{ tone: "muted", text: `Today ${formatCredits(input.stats.todayCredits)}` }]
  const quota = input.quota
  if (input.quotaError !== undefined || (quota && !quota.available)) {
    lines.push({ tone: "muted", text: "Quota unavailable" })
    return lines
  }
  if (quota === undefined) {
    lines.push({ tone: "muted", text: "Quota loading..." })
    return lines
  }
  lines.push({ tone: "muted", text: `${formatQuotaNumber(quota.used)} / ${formatQuotaNumber(quota.total)}（已使用 ${quota.percentage}%）` })
  lines.push({ tone: "muted", text: `剩余 ${formatQuotaNumber(quota.remaining)} · 距离重置还有 ${daysUntil(quota.expiresAt, input.nowMs)} 天` })
  return lines
}

function daysUntil(expiresAt, nowMs) {
  const expiryMs = new Date(expiresAt).getTime()
  if (!Number.isFinite(expiryMs)) return 0
  return Math.max(0, Math.ceil((expiryMs - nowMs) / 86_400_000))
}
