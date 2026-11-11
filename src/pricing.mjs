/**
 * 文件职责：每模型积分倍率快照的缓存（10 分钟 TTL、单飞、失败保留旧快照）、每日时段换算与倍率、倒计时、促销态文案。
 * 上游：index.ts 的 pricing RPC 与 status/models/refresh 命令；panel.tsx 经 RPC 取数渲染「模型倍率」段。
 * 下游：无（真实倍率提取器由 index.ts 经 fetchPricing 注入；未注入时不读取任何来源）。
 */

/** 倍率快照的默认缓存时长：10 分钟。 */
export const PRICING_TTL_MS = 10 * 60 * 1000

/** 倍率提取的默认超时：30 秒。 */
export const PRICING_TIMEOUT_MS = 30 * 1000

/**
 * 创建倍率快照读取器。
 *
 * 快照缺失、过期或 refresh 时才调用 fetchPricing；同一时刻的并发调用共享一次请求。
 * 失败或返回 null 时保留上一份成功快照，且不更新抓取时间——旧数据仍按原 fetchedAt 展示，
 * 不会被伪装成新鲜数据。只有成功返回快照才刷新缓存时间。
 *
 * @param {{ fetchPricing?: () => Promise<object|null>, ttlMs?: number, now?: () => number }} [options]
 * @returns {{ read: (input?: { refresh?: boolean }) => Promise<object|null>, dispose: () => void }}
 */
export function createPricingStore(options = {}) {
  const ttlMs = options.ttlMs ?? PRICING_TTL_MS
  // 未注入提取器时不读取任何来源：面板与命令隐藏倍率段。
  // 生产路径由 index.ts 默认注入 fetchPricingFromQoder（src/pricing-qoder.mjs）。
  const fetchPricing = options.fetchPricing ?? (async () => null)
  const now = options.now ?? Date.now
  let cached = null
  let cachedAt = 0
  let inFlight
  let disposed = false

  const read = async ({ refresh = false } = {}) => {
    if (disposed) return cached
    if (!refresh && cached && now() - cachedAt < ttlMs) return cached
    if (inFlight) return inFlight

    inFlight = (async () => {
      try {
        const snapshot = await fetchPricing()
        if (!disposed && snapshot) {
          cached = snapshot
          cachedAt = now()
        }
      } catch {
        // 失败保留旧快照；错误不向调用方抛出，面板与命令只展示上一次成功的数据。
      }
      return cached
    })()
    try {
      return await inFlight
    } finally {
      inFlight = undefined
    }
  }

  return {
    read,
    dispose() {
      disposed = true
    },
  }
}

/**
 * 倍率显示：固定两位小数并带 `x`；非法值返回空串，由调用方决定是否展示。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatFactor(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  return `${value.toFixed(2)}x`
}

/**
 * 目标时间相对 now 的倒计时：<1 小时「N 分」、<24 小时「N 小时 M 分」、否则「N 天 M 小时」。
 * 目标缺失或非法返回空串；已过期按 0 分展示。
 *
 * @param {string|number|undefined} target ISO 时间或绝对毫秒
 * @param {number} [nowMs]
 * @returns {string}
 */
export function countdownText(target, nowMs = Date.now()) {
  const targetMs = typeof target === "number" ? (Number.isFinite(target) ? target : undefined) : parseTime(target)
  if (targetMs === undefined) return ""
  const diffMs = Math.max(0, targetMs - nowMs)
  const minutes = Math.floor(diffMs / 60_000)
  if (diffMs < 3_600_000) return `${minutes} 分`
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)} 小时 ${minutes % 60} 分`
  return `${Math.floor(diffMs / 86_400_000)} 天 ${Math.floor((diffMs % 86_400_000) / 3_600_000)} 小时`
}

/**
 * 指定 IANA 时区里「下一次 HH:mm 墙上时间」的绝对毫秒。
 *
 * 促销窗口是每日重复的墙上时间（可跨午夜，如 22:00–08:00），不是 ISO 绝对时刻。
 * 只用 Intl.DateTimeFormat 取目标时区的墙上时间，不依赖服务器本机时区；
 * 同一墙上时刻在当前时刻之前（含恰好相等）时顺延到次日。
 *
 * @param {string|undefined} hhmm 24 小时制 "HH:mm"。
 * @param {string|undefined} timezone IANA 时区名，如 "Asia/Shanghai"。
 * @param {number} [nowMs]
 * @returns {number|undefined} 绝对毫秒；非法输入或时区不可用时返回 undefined。
 */
export function nextDailyWindow(hhmm, timezone, nowMs = Date.now()) {
  if (typeof hhmm !== "string" || typeof timezone !== "string" || timezone.trim().length === 0) return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return undefined

  let today
  try {
    today = wallDate(nowMs, timezone)
  } catch {
    return undefined
  }
  if (!today) return undefined

  const wallMidnight = Date.UTC(today.year, today.month - 1, today.day, 0, 0, 0)
  let candidateWall = wallMidnight + hour * 3_600_000 + minute * 60_000
  let candidate = absoluteForWall(candidateWall, nowMs, timezone)
  if (candidate <= nowMs) {
    candidateWall += 86_400_000
    candidate = absoluteForWall(candidateWall, nowMs, timezone)
  }
  return candidate
}

/**
 * 促销态文案。
 * - 低峰进行中：`低峰 · {到下一次 windowEnd 的倒计时}后恢复 {beforePromotionPriceFactor ?? originalPriceFactor}x`
 * - 尚未开始：`{到下一次 windowStart 的倒计时}后进入{badge || '低峰折扣'}`
 *   徽标按原样展示，不乘 discountFactor（客户端没有该换算）。
 * - 窗口或时区缺失/非法：返回空串，调用方只展示当前倍率。
 *
 * @param {Record<string, any>|undefined} model
 * @param {number} [nowMs]
 * @returns {string}
 */
export function promotionText(model, nowMs = Date.now()) {
  const promotion = model?.promotion
  if (!promotion || typeof promotion !== "object") return ""
  const timezone = typeof promotion.timezone === "string" ? promotion.timezone : ""
  if (!timezone) return ""
  if (promotion.active === true) {
    const restore = firstFinite(promotion.beforePromotionPriceFactor, model.originalPriceFactor)
    const endMs = nextDailyWindow(promotion.windowEnd, timezone, nowMs)
    if (endMs === undefined || restore === undefined) return ""
    return `低峰 · ${countdownText(endMs, nowMs)}后恢复 ${formatFactor(restore)}`
  }
  if (promotion.active === false) {
    const startMs = nextDailyWindow(promotion.windowStart, timezone, nowMs)
    if (startMs === undefined) return ""
    return `${countdownText(startMs, nowMs)}后进入${promotionBadge(promotion)}`
  }
  return ""
}

/**
 * 单个模型的「当前倍率 + 促销态」文本；倍率非法时返回空串。
 *
 * @param {Record<string, any>|undefined} model
 * @param {number} [nowMs]
 * @returns {string}
 */
export function modelPricingLine(model, nowMs = Date.now()) {
  const factor = formatFactor(model?.priceFactor)
  if (!factor) return ""
  const promotion = promotionText(model, nowMs)
  return promotion ? `${factor} ${promotion}` : factor
}

/**
 * 面板「模型倍率」段：数据缺失或为空时返回空数组，让整段隐藏。
 *
 * 展开（默认）：`模型倍率 ▾` + 每行 `{modelKey} {factor}x {促销态}` + 尾行 `{HH:mm} 更新`。
 * 折叠：只剩 `模型倍率 ▸ {有效模型数}` 一行。
 * 两种状态的标题行都带 `action: "toggle-pricing"`，由面板接线到鼠标左键点击切换。
 *
 * 调用方：panel.tsx（经 createMemo 渲染面板行）。
 *
 * @param {{ pricing?: Record<string, any>|null, nowMs?: number, collapsed?: boolean }} [input]
 * @returns {Array<{ tone: "base"|"muted", text: string, action?: "toggle-pricing" }>}
 */
export function pricingPanelLines(input = {}) {
  const pricing = input.pricing
  const nowMs = input.nowMs ?? Date.now()
  const models = Array.isArray(pricing?.models) ? pricing.models : []
  const rows = []
  for (const model of models) {
    const key = typeof model?.modelKey === "string" ? model.modelKey.trim() : ""
    if (!key) continue
    const detail = modelPricingLine(model, nowMs)
    if (!detail) continue
    rows.push({ tone: "muted", text: `${key} ${detail}` })
  }
  if (rows.length === 0) return []
  if (input.collapsed === true) {
    return [{ tone: "base", text: `模型倍率 ▸ ${rows.length}`, action: "toggle-pricing" }]
  }
  const lines = [{ tone: "base", text: "模型倍率 ▾", action: "toggle-pricing" }, ...rows]
  const updated = formatUpdatedAt(pricing.fetchedAt)
  if (updated) lines.push({ tone: "muted", text: `${updated} 更新` })
  return lines
}

/**
 * `/qoder status` 的 Pricing 摘要：低峰进行中或倒计时进入低峰。
 * 无快照时返回 undefined，调用方整行省略。
 *
 * @param {Record<string, any>|null|undefined} pricing
 * @param {number} [nowMs]
 * @returns {string|undefined}
 */
export function pricingStatusLine(pricing, nowMs = Date.now()) {
  const models = Array.isArray(pricing?.models) ? pricing.models : []
  if (models.length === 0) return undefined

  const active = models.find((model) => model?.promotion?.active === true)
  if (active) {
    const restore = firstFinite(active.promotion.beforePromotionPriceFactor, active.originalPriceFactor)
    const endMs = nextDailyWindow(active.promotion.windowEnd, active.promotion.timezone, nowMs)
    if (endMs !== undefined && restore !== undefined) {
      return `- Pricing: 低峰进行中，${countdownText(endMs, nowMs)}后恢复 ${formatFactor(restore)}`
    }
    return "- Pricing: 低峰进行中"
  }

  const upcoming = models
    .filter((model) => model?.promotion?.active === false)
    .map((model) => ({
      model,
      startMs: nextDailyWindow(model.promotion.windowStart, model.promotion.timezone, nowMs),
    }))
    .filter((entry) => entry.startMs !== undefined)
    .sort((a, b) => a.startMs - b.startMs)[0]
  if (upcoming) {
    return `- Pricing: ${countdownText(upcoming.startMs, nowMs)}后进入${promotionBadge(upcoming.model.promotion)}`
  }

  return `- Pricing: ${models.length} 个模型，当前无低峰折扣`
}

/** 促销徽标：原样展示，缺省为「低峰折扣」；不做倍率换算。 */
function promotionBadge(promotion) {
  const badge = typeof promotion?.badge === "string" ? promotion.badge.trim() : ""
  return badge.length > 0 ? badge : "低峰折扣"
}

/** 目标时区里 now 对应的年月日。 */
function wallDate(nowMs, timezone) {
  const parts = zonedParts(nowMs, timezone)
  return parts ? { year: parts.year, month: parts.month, day: parts.day } : undefined
}

/** 用 Intl 取绝对毫秒在目标时区的墙上时间；非法时区由 Intl 抛错，由调用方处理。 */
function zonedParts(ms, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const fields = {}
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") fields[part.type] = part.value
  }
  const values = {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    second: Number(fields.second),
  }
  return Object.values(values).every(Number.isFinite) ? values : undefined
}

/** 目标时区在绝对毫秒 ms 的 UTC 偏移（毫秒）。 */
function offsetAt(ms, timezone) {
  const parts = zonedParts(ms, timezone)
  if (!parts) return 0
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return wall - Math.floor(ms / 1000) * 1000
}

/** 墙上时间 → 绝对毫秒：先按当前偏移估算，再用候选时刻的偏移校正一次。 */
function absoluteForWall(wallMs, nowMs, timezone) {
  const first = wallMs - offsetAt(nowMs, timezone)
  return wallMs - offsetAt(first, timezone)
}

/** ISO 时间 → 毫秒；非法值返回 undefined。 */
function parseTime(value) {
  if (typeof value !== "string") return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** 返回第一个有限数值，用于 beforePromotionPriceFactor 回退到 originalPriceFactor。 */
function firstFinite(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

/** fetchedAt → 本机时区的 HH:mm；非法值返回空串。 */
function formatUpdatedAt(iso) {
  const ms = parseTime(iso)
  if (ms === undefined) return ""
  const date = new Date(ms)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
