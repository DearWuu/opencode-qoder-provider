/**
 * 文件职责：把本地调用日志聚合成侧边栏面板的稳定数据集（total/today/last）。
 * 上游：index.ts 的 stats RPC。
 * 下游：src/logger.sumCredits。
 */
import { sumCredits } from "./logger.mjs"

/**
 * 把本地调用日志聚合成侧边栏面板的稳定数据集。
 *
 * 纯函数：调用方传入从 JSONL 日志读出的条目与可注入时钟，因此不涉及模型调用或网络访问。
 * "今天"指 `now` 所在的本机日历日。
 *
 * 每个字段恒存在且非 null：缺失值表现为 `""` 或 `0`，让 RPC 输出 schema 保持简单可校验。
 *
 * @param {Array<Record<string, any>>} entries 调用日志条目，按时间从旧到新
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
 * 本地日历日，格式 `YYYY-MM-DD`；非法日期返回 null。
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
