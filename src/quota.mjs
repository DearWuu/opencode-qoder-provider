/**
 * 文件职责：解析 Qoder 官方 `/usage` 屏幕为真实额度，并提供 5 分钟内存缓存与请求单飞。
 * 上游：index.ts 的 quota RPC、status/refresh 命令与 panel.tsx 的 quota RPC 调用。
 * 下游：src/quota-cli.readOfficialUsage（默认）、src/variants（变体的额度标签优先级与来源文案）；不读取登录态、不直接访问账户 HTTP API。
 */
import { formatQuotaNumber } from "./credits.mjs"
import { readOfficialUsage } from "./quota-cli.mjs"
import { DEFAULT_VARIANT_ID, getVariant } from "./variants.mjs"

export { formatQuotaNumber } from "./credits.mjs"

export const QUOTA_TTL_MS = 5 * 60 * 1000
export const QUOTA_SOURCE = "Qoder CLI /usage"

/** 官方屏上可能出现的额度标签（取值顺序由变体决定）。 */
export const QUOTA_LABELS = ["OrgResourcePackage", "PlanCreditsUsed", "Add-onCreditsUsed"]

/**
 * 从官方 `/usage` 输出提取唯一明确的额度。
 *
 * 同一屏出现多个数值额度时按 `labels` 优先级取第一个，不做相加：
 * 真实屏（2026-11-16 取证）CN 显示 `OrgResourcePackage:9749/10000`、`PlanCreditsUsed:N/A`；
 * 海外 Teams 显示 `PlanCreditsUsed:4/570`、`OrgResourcePackage:0/5000`（未消耗的组织额度包）。
 *
 * @param {string} output
 * @param {{ now?: Date, labels?: string[], source?: string }} [options]
 * @returns {{ available: boolean, source: string, used: number, total: number, remaining: number, percentage: number, expiresAt: string, fetchedAt: string, error: string }}
 */
export function parseOfficialQuota(output, { now = new Date(), labels = QUOTA_LABELS, source = QUOTA_SOURCE } = {}) {
  const fetchedAt = now.toISOString()
  const text = stripTerminalSequences(output)
  const compact = text.replace(/\s+/g, "")
  const expiresAt = parsePlanExpiration(compact)
  const quota = pickQuota(compact, labels)
  if (!quota || !expiresAt) {
    return unavailable("Official /usage output did not include one complete credit quota and expiry.", fetchedAt, source)
  }

  const { used, total } = quota
  if (used === undefined || total === undefined || total <= 0 || used < 0 || used > total) {
    return unavailable("Official /usage credit values were missing or inconsistent.", fetchedAt, source)
  }
  return {
    available: true,
    source,
    used,
    total,
    remaining: total - used,
    percentage: Math.round((used / total) * 100),
    expiresAt,
    fetchedAt,
    error: "",
  }
}

/**
 * 按优先级取第一个完整的数值额度。
 *
 * @param {string} compact 去空白后的屏幕文本
 * @param {string[]} labels 标签优先级
 * @returns {{ used: number, total: number }|undefined}
 */
export function pickQuota(compact, labels = QUOTA_LABELS) {
  for (const label of labels) {
    const match = new RegExp(`${label}:([\\d,]+(?:\\.\\d+)?)\\/([\\d,]+(?:\\.\\d+)?)`).exec(compact)
    if (!match) continue
    const used = parseDecimal(match[1])
    const total = parseDecimal(match[2])
    if (used === undefined || total === undefined) continue
    return { used, total }
  }
  return undefined
}

/** 去除 ANSI 控制序列；只用于解析，不把屏幕原文写入日志或 RPC 错误。 */
export function stripTerminalSequences(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\r/g, "\n")
}

/**
 * 创建配额读取器。只有缓存缺失/到期或 refresh/status 主动请求才会启动 CLI；
 * 同一时刻的并发调用共享一个 PTY 进程。
 *
 * @param {{ cliPath: string, variantId?: string, cwd?: string, timeoutMs?: number, ttlMs?: number,
 *   readUsage?: (options: Record<string, any>) => Promise<string>, now?: () => number }} options
 */
export function createQuotaStore(options) {
  const ttlMs = options.ttlMs ?? QUOTA_TTL_MS
  const readUsage = options.readUsage ?? readOfficialUsage
  const now = options.now ?? Date.now
  const variant = getVariant(options.variantId ?? DEFAULT_VARIANT_ID)
  let cached
  let cachedAt = 0
  let inFlight
  let activeAbort
  let disposed = false

  const read = async ({ refresh = false } = {}) => {
    if (disposed) return withCacheFlag(unavailable("Quota reader is disposed.", new Date(now()).toISOString(), variant.quotaSource), false)
    if (!refresh && cached && now() - cachedAt < ttlMs) return withCacheFlag(cached, true)
    if (inFlight) return inFlight

    const controller = new AbortController()
    activeAbort = controller
    inFlight = (async () => {
      let result
      try {
        const output = await readUsage({
          cliPath: options.cliPath,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          signal: controller.signal,
        })
        result = parseOfficialQuota(output, {
          now: new Date(now()),
          labels: variant.quotaLabels,
          source: variant.quotaSource,
        })
      } catch (error) {
        result = unavailable(safeError(error), new Date(now()).toISOString(), variant.quotaSource)
      }
      if (!disposed) {
        cached = result
        cachedAt = now()
      }
      return withCacheFlag(result, false)
    })()
    try {
      return await inFlight
    } finally {
      inFlight = undefined
      activeAbort = undefined
    }
  }

  return {
    read,
    dispose() {
      disposed = true
      activeAbort?.abort()
    },
  }
}

/** status 对话框展示真实来源和错误，不抛出额度异常。 */
export function formatQuotaStatus(quota) {
  const lines = []
  if (quota.available) {
    lines.push(
      `- Quota: ${formatQuotaNumber(quota.used)} / ${formatQuotaNumber(quota.total)} used (${quota.percentage}%); ` +
      `${formatQuotaNumber(quota.remaining)} remaining; expires ${quota.expiresAt}`,
    )
  } else {
    lines.push(`- Quota: unavailable — ${quota.error || "official quota is not available"}`)
  }
  lines.push(`- Quota source: ${quota.source}; fetched ${quota.fetchedAt}${quota.cached ? " (cache)" : ""}`)
  return lines.join("\n")
}

function withCacheFlag(quota, cached) {
  return { ...quota, cached }
}

function unavailable(error, fetchedAt, source = QUOTA_SOURCE) {
  return {
    available: false,
    source,
    used: 0,
    total: 0,
    remaining: 0,
    percentage: 0,
    expiresAt: "",
    fetchedAt,
    error,
  }
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 300) || "Unknown quota error."
}

function parseDecimal(value) {
  if (typeof value !== "string") return undefined
  const parsed = Number(value.replace(/,/g, ""))
  return Number.isFinite(parsed) ? parsed : undefined
}

function parsePlanExpiration(compact) {
  const match = compact.match(/PlanExpiresAt:([A-Za-z]{3})(\d{1,2}),(\d{4}),(\d{2}):(\d{2}):(\d{2})GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!match) return ""
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
  const month = months[match[1]]
  if (month === undefined) return ""
  const [, , day, year, hour, minute, second, sign, offsetHour, offsetMinute = "0"] = match
  const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second))
  const offsetMs = (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000
  const timestamp = utc - (sign === "+" ? offsetMs : -offsetMs)
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ""
}
