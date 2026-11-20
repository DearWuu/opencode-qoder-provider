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
 * 额度标签的中文显示名（面板多额度行与 status 文案共用）。
 *
 * 注意：`name` 是展示层字段，只给用户看，不承载业务语义——改文案/做本地化时只需改这张表，
 * 消费方不得把 `name` 当标签键做判断（契约里的稳定键是 `label`，`name` 随文案变化）。
 */
export const QUOTA_DISPLAY_NAMES = {
  PlanCreditsUsed: "个人",
  OrgResourcePackage: "共享资源包",
  "Add-onCreditsUsed": "加量包",
}

/** 未知额度标签的兜底显示名：不把英文原值（如 `SomeNewPackage`）直接显示给用户。 */
export const UNKNOWN_QUOTA_NAME = "其他额度"

/**
 * 从官方 `/usage` 输出提取额度。
 *
 * 主额度（used/total 等字段）按 `labels` 优先级取第一个，不做相加：
 * 真实屏（2026-11-16 取证）CN 显示 `OrgResourcePackage:9749/10000`、`PlanCreditsUsed:N/A`；
 * 海外 Teams 显示 `PlanCreditsUsed:4/570`、`OrgResourcePackage:0/5000`（未消耗的组织额度包）。
 * `quotas` 额外收集同屏全部完整数值额度（含共享资源包），供面板逐行展示。
 *
 * @param {string} output
 * @param {{ now?: Date, labels?: string[], source?: string }} [options]
 * @returns {{ available: boolean, source: string, used: number, total: number, remaining: number, percentage: number, expiresAt: string, fetchedAt: string, error: string, quotas: Array<{ label: string, name: string, used: number, total: number, remaining: number, percentage: number }> }}
 */
export function parseOfficialQuota(output, { now = new Date(), labels = QUOTA_LABELS, source = QUOTA_SOURCE } = {}) {
  const fetchedAt = now.toISOString()
  const text = stripTerminalSequences(output)
  const compact = text.replace(/\s+/g, "")
  const expiresAt = parsePlanExpiration(compact)
  const quota = pickQuota(compact, labels)
  if (!quota || !expiresAt) {
    // 屏上有数值对但全部不自洽（如 used > total）时给出“数值异常”，否则说明压根没找到完整额度。
    const malformed = labels.some((label) => matchQuotaPair(label, compact) !== undefined)
    const error = !expiresAt || !malformed
      ? "Official /usage output did not include one complete credit quota and expiry."
      : "Official /usage credit values were missing or inconsistent."
    return unavailable(error, fetchedAt, source)
  }

  return {
    available: true,
    source,
    used: quota.used,
    total: quota.total,
    remaining: quota.remaining,
    percentage: quota.percentage,
    expiresAt,
    fetchedAt,
    error: "",
    quotas: collectQuotas(compact, labels),
  }
}

/**
 * 收集同屏全部完整数值额度（按标签优先级排序），绝不相加。
 *
 * 调用方：parseOfficialQuota（quotas 字段，面板多额度行与 RPC 透传）。
 *
 * @param {string} compact 去空白后的屏幕文本
 * @param {string[]} labels 标签优先级
 * @returns {Array<{ label: string, name: string, used: number, total: number, remaining: number, percentage: number }>}
 */
export function collectQuotas(compact, labels = QUOTA_LABELS) {
  const entries = []
  for (const label of labels) {
    const entry = matchQuota(label, compact)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * 按优先级取第一个完整的数值额度。
 *
 * 与 collectQuotas 共用 matchQuota 的匹配与校验，保证“主额度是哪条”和“quotas 含哪几条”口径一致：
 * 首选标签的数值不自洽（如 0/0、used > total）时自动回落到下一条合法额度，而不是整屏 unavailable。
 *
 * @param {string} compact 去空白后的屏幕文本
 * @param {string[]} labels 标签优先级
 * @returns {{ label: string, name: string, used: number, total: number, remaining: number, percentage: number }|undefined}
 */
export function pickQuota(compact, labels = QUOTA_LABELS) {
  for (const label of labels) {
    const entry = matchQuota(label, compact)
    if (entry) return entry
  }
  return undefined
}

/**
 * 屏幕文本里某个标签的额度对（只做语法匹配，不校验取值范围）。
 *
 * 调用方：matchQuota（取值）与 parseOfficialQuota（区分“数值异常”和“没有完整额度”两种错误文案）。
 *
 * @param {string} label
 * @param {string} compact 去空白后的屏幕文本
 * @returns {{ used: number, total: number }|undefined}
 */
function matchQuotaPair(label, compact) {
  const match = new RegExp(`${label}:([\\d,]+(?:\\.\\d+)?)\\/([\\d,]+(?:\\.\\d+)?)`).exec(compact)
  if (!match) return undefined
  const used = parseDecimal(match[1])
  const total = parseDecimal(match[2])
  if (used === undefined || total === undefined) return undefined
  return { used, total }
}

/**
 * 单个标签的额度；语法匹配 + 取值校验（total > 0、0 <= used <= total）通过才返回。
 * 同一标签在屏上出现多次时只取第一处（正则非 global）。
 *
 * @param {string} label
 * @param {string} compact 去空白后的屏幕文本
 * @returns {{ label: string, name: string, used: number, total: number, remaining: number, percentage: number }|undefined}
 */
function matchQuota(label, compact) {
  const pair = matchQuotaPair(label, compact)
  if (!pair || pair.total <= 0 || pair.used < 0 || pair.used > pair.total) return undefined
  return {
    label,
    name: QUOTA_DISPLAY_NAMES[label] ?? UNKNOWN_QUOTA_NAME,
    used: pair.used,
    total: pair.total,
    remaining: pair.total - pair.used,
    percentage: Math.round((pair.used / pair.total) * 100),
  }
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

/**
 * status 对话框展示真实来源和错误，不抛出额度异常。多额度时逐行带标签。
 *
 * expires 只在末尾给一次：官方 `/usage` 只有一个 `PlanExpiresAt`（plan expiry），
 * 逐条额度没有独立到期时间，因此不在每条额度上重复或伪造 expires。
 * 只剩一条数值额度时沿用无标签单行（面板同口径），宁可少一个标签也不改变既有单额度文案。
 */
export function formatQuotaStatus(quota) {
  const lines = []
  if (quota.available) {
    const entries = Array.isArray(quota.quotas) && quota.quotas.length > 1 ? quota.quotas : undefined
    if (entries) {
      for (const entry of entries) {
        lines.push(
          `- Quota（${entry.name}）: ${formatQuotaNumber(entry.used)} / ${formatQuotaNumber(entry.total)} used (${entry.percentage}%); ` +
          `${formatQuotaNumber(entry.remaining)} remaining`,
        )
      }
      lines.push(`- Quota expires: ${quota.expiresAt}`)
    } else {
      lines.push(
        `- Quota: ${formatQuotaNumber(quota.used)} / ${formatQuotaNumber(quota.total)} used (${quota.percentage}%); ` +
        `${formatQuotaNumber(quota.remaining)} remaining; expires ${quota.expiresAt}`,
      )
    }
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
    quotas: [],
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
