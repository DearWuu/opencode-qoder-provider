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
 * 额度金额行的唯一写法：`6,872 / 10,000（69%）`；传 `label` 时前置标签：`个人 4 / 570（1%）`。
 *
 * 单额度行（不带标签）与多额度行（逐行带标签）共用本函数；不带「已使用」是为了在 37 列侧边栏内
 * 放下最长的共享资源包行（实测 ≤34 列），README 的额度示例以本函数输出为准。
 *
 * 调用方：creditsPanelLines；test/credits.test.ts 直接锁定格式。
 *
 * @param {{ used: number, total: number, percentage: number, label?: string }} input
 * @returns {string}
 */
export function quotaAmountText({ used, total, percentage, label }) {
  const amount = `${formatQuotaNumber(used)} / ${formatQuotaNumber(total)}（${percentage}%）`
  return label === undefined || label === "" ? amount : `${label} ${amount}`
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
 * Today 来自本地日志；额度行只展示官方 `/usage` 返回的额度：
 * 单额度一行无标签，多额度（quotas）逐行带标签（个人/共享资源包/加量包），两种都走 quotaAmountText。
 * 剩余行取主额度（`quota.remaining`）；多额度时在剩余值前加主额度标签，避免与屏上其他额度池混淆。
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
  const entries = Array.isArray(quota.quotas) && quota.quotas.length > 1 ? quota.quotas : undefined
  if (entries) {
    for (const entry of entries) {
      lines.push({ tone: "muted", text: quotaAmountText({ used: entry.used, total: entry.total, percentage: entry.percentage, label: entry.name }) })
    }
  } else {
    // 只剩一条数值额度时保持无标签单行：单额度文案是既有对外口径，不为标签破坏兼容。
    lines.push({ tone: "muted", text: quotaAmountText(quota) })
  }
  // 剩余值来自主额度；多额度时加标签说明是哪个额度池的剩余，单额度只保留原有分隔空格。
  const primaryName = entries?.[0]?.name
  const remainingLabel = primaryName ? `（${primaryName}）` : " "
  lines.push({ tone: "muted", text: `剩余${remainingLabel}${formatQuotaNumber(quota.remaining)} · 距离重置还有 ${daysUntil(quota.expiresAt, input.nowMs)} 天` })
  return lines
}

/**
 * 面板末尾固定的手动刷新行：空闲时 `⟳ 刷新`，刷新中 `刷新中…`。
 *
 * 该行始终存在（与是否有数据无关），`action: "refresh"` 由面板接线到
 * quota+pricing 的强制刷新；Today 只读本地日志，不参与刷新。
 *
 * 调用方：panel.tsx（经 createMemo 渲染面板行）。
 *
 * @param {{ refreshing?: boolean }} [input]
 * @returns {Array<{ tone: "muted", text: string, action: "refresh" }>}
 */
export function panelFooterLines(input = {}) {
  return [{ tone: "muted", text: input.refreshing === true ? "刷新中…" : "⟳ 刷新", action: "refresh" }]
}

function daysUntil(expiresAt, nowMs) {
  const expiryMs = new Date(expiresAt).getTime()
  if (!Number.isFinite(expiryMs)) return 0
  return Math.max(0, Math.ceil((expiryMs - nowMs) / 86_400_000))
}
