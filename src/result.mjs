/**
 * 文件职责：CLI 原始结果 → AI SDK V3 结果（content/finishReason/usage/providerMetadata），含 Credits 提取与模型回落判定。
 * 上游：src/provider 的 execute/buildGenerateResult。
 * 下游：无。
 */

/**
 * 提取 Credits 用量与 CLI 的计费 key。
 * `modelUsage` 的 key 不能作为"哪个模型实际服务了请求"的证据。
 *
 * 主条目是第一个真正记账的 `modelUsage` 条目（credits > 0 或任一 token 计数非零）。
 * CLI 可能在全 0 的 `auto` 条目旁输出真实的 `fast` 条目；只看 key 顺序会报成零用量。
 */
export function summarizeModelUsage(raw) {
  const modelUsage = raw?.modelUsage && typeof raw.modelUsage === "object" ? raw.modelUsage : {}
  const keys = Object.keys(modelUsage)
  const primaryKey = pickUsageModelKey(modelUsage)
  const primary = primaryKey ? (modelUsage[primaryKey] ?? {}) : {}
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {}

  const inputTotal = numberOrUndefined(primary.inputTokens ?? usage.input_tokens)
  const outputTotal = numberOrUndefined(primary.outputTokens ?? usage.output_tokens)
  const cacheRead = numberOrUndefined(primary.cacheReadInputTokens ?? usage.cache_read_input_tokens)
  const cacheWrite = numberOrUndefined(primary.cacheCreationInputTokens ?? usage.cache_creation_input_tokens)

  const noCache = inputTotal !== undefined && cacheRead !== undefined ? Math.max(0, inputTotal - cacheRead) : undefined

  return {
    usageModelKey: primaryKey,
    usageModelKeys: keys,
    credits: numberOrUndefined(primary.credits),
    inputTokens: inputTotal,
    outputTokens: outputTotal,
    cacheRead,
    cacheWrite,
    contextUsageRatio: readContextUsageRatio(raw),
    modelUsage,
  }
}

/**
 * 读取 `usage.context_usage_ratio`（回退到顶层）。CLI 1.1.85 把每个 token 计数都置 0，
 * 但这个比例仍然真实。
 *
 * @param {any} raw
 * @returns {number|undefined} (0, 1] 区间的比例；缺失或非法时为 undefined
 */
export function readContextUsageRatio(raw) {
  for (const value of [raw?.usage?.context_usage_ratio, raw?.context_usage_ratio]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) return value
  }
  return undefined
}

/** 表示输出触及 token 长度上限的 `stop_reason` 取值。 */
const LENGTH_STOP_REASONS = new Set(["max_tokens", "max-output-tokens"])

/** 把 CLI 的 `stop_reason` 映射为统一的 finish reason。 */
export function toUnifiedFinishReason(raw) {
  if (raw?.is_error === true) return "error"
  return LENGTH_STOP_REASONS.has(raw?.stop_reason) ? "length" : "stop"
}

/**
 * 选出真正承载记账信息的 `modelUsage` key：credits > 0 或任一 token 计数非零。
 * 没有条目符合时退回第一个 key（全 0 记账仍按 CLI 自己的顺序报告）。
 */
function pickUsageModelKey(modelUsage) {
  const keys = Object.keys(modelUsage)
  for (const key of keys) {
    const entry = modelUsage[key]
    if (!entry || typeof entry !== "object") continue
    if (numberOrUndefined(entry.credits) > 0) return key
    if (
      numberOrUndefined(entry.inputTokens) > 0 ||
      numberOrUndefined(entry.outputTokens) > 0 ||
      numberOrUndefined(entry.cacheReadInputTokens) > 0 ||
      numberOrUndefined(entry.cacheCreationInputTokens) > 0
    ) {
      return key
    }
  }
  return keys[0]
}

const FALLBACK_PATTERNS = [
  /\bModel\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9][A-Za-z0-9._-]*))[^\r\n]*?\bfalling\s+back\s+to\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9][A-Za-z0-9._-]*))/i,
  /\bModel\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9][A-Za-z0-9._-]*))[^\r\n]*?\busing\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9][A-Za-z0-9._-]*))\s+instead\b/i,
]

/** 只识别 CLI 明确写入 stderr 的模型回落提示。 */
export function detectFallback(requestedModel, stderr) {
  const text = typeof stderr === "string" ? stderr : ""
  for (const line of text.split(/\r?\n/)) {
    for (const pattern of FALLBACK_PATTERNS) {
      const match = pattern.exec(line)
      if (match) return { fellBack: true, actualModel: match[4] ?? match[5] ?? match[6] }
    }
  }
  return { fellBack: false, actualModel: requestedModel }
}

export class ModelFallbackError extends Error {
  constructor(requestedModel, actualModel) {
    super(`Qoder model fallback detected: requested "${requestedModel}" was served by "${actualModel}". The response was rejected.`)
    this.name = "ModelFallbackError"
    this.requestedModel = requestedModel
    this.actualModel = actualModel
  }
}

/**
 * 解析展示给 UI 的输入 token 总数。
 * 真实的非零计数优先；计数缺失或为 0 且 `context_usage_ratio` 有效时，
 * 用 `ratio * contextLimit` 近似。
 *
 * @param {{ inputTokens?: number, contextUsageRatio?: number }} summary
 * @param {number} contextLimit
 * @returns {{ total: number|undefined, approximated: boolean }}
 */
export function resolveInputTokens(summary, contextLimit) {
  const real = summary.inputTokens
  if (real !== undefined && real > 0) return { total: real, approximated: false }
  if (summary.contextUsageRatio !== undefined && Number.isFinite(contextLimit) && contextLimit > 0) {
    return { total: Math.round(summary.contextUsageRatio * contextLimit), approximated: true }
  }
  return { total: real, approximated: false }
}

/** 构建 AI SDK V3 的 usage 块（嵌套的输入/输出 token 计数）。 */
export function buildUsage(raw, { contextLimit } = {}) {
  const summary = summarizeModelUsage(raw)
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {}
  const input = resolveInputTokens(summary, contextLimit)

  return {
    inputTokens: {
      total: input.total,
      noCache: input.total !== undefined && summary.cacheRead !== undefined
        ? Math.max(0, input.total - summary.cacheRead)
        : undefined,
      cacheRead: summary.cacheRead,
      cacheWrite: summary.cacheWrite,
    },
    outputTokens: {
      total: summary.outputTokens,
      text: summary.outputTokens,
      reasoning: undefined,
    },
    raw: usage,
  }
}

/** 由 CLI 结果构建 `providerMetadata.qoder`。 */
/**
 * @param {{ raw: any, requestedModel: string, fallback?: { actualModel?: string, fellBack?: boolean }, contextLimit?: number }} params
 */
export function buildProviderMetadata({ raw, requestedModel, fallback = undefined, contextLimit = undefined }) {
  const summary = summarizeModelUsage(raw)
  const input = resolveInputTokens(summary, contextLimit)
  const metadata = {
    sessionId: raw?.session_id,
    uuid: raw?.uuid,
    credits: numberOrUndefined(raw?.total_credits),
    totalCredits: numberOrUndefined(raw?.total_credits),
    modelCredits: summary.credits,
    requestedModel,
    actualModel: fallback?.actualModel ?? requestedModel,
    modelFallback: fallback?.fellBack === true,
    usageModelKey: summary.usageModelKey,
    usageModelKeys: summary.usageModelKeys,
    modelUsage: summary.modelUsage,
    contextUsageRatio: summary.contextUsageRatio,
    approximatedContextTokens: input.approximated,
    permissionDenials: Array.isArray(raw?.permission_denials) ? raw.permission_denials : [],
    durationMs: numberOrUndefined(raw?.duration_ms),
    numTurns: numberOrUndefined(raw?.num_turns),
    isError: raw?.is_error === true,
    stopReason: raw?.stop_reason,
  }
  return stripUndefined(metadata)
}

/**
 * 把 CLI 原始结果转换成 AI SDK V3 generate 结果。
 * 明确的模型回落会在到达这里之前被 `execute` 拒绝。
 */
export function buildGenerateResult({ raw, requestedModel, contextLimit }) {
  const isError = raw?.is_error === true
  const text = typeof raw?.result === "string" ? raw.result : ""

  return {
    content: [{ type: "text", text }],
    finishReason: {
      unified: toUnifiedFinishReason(raw),
      raw: typeof raw?.stop_reason === "string" ? raw.stop_reason : isError ? "error" : "end_turn",
    },
    usage: buildUsage(raw, { contextLimit }),
    warnings: [],
    providerMetadata: {
      qoder: buildProviderMetadata({ raw, requestedModel, contextLimit }),
    },
  }
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** @param {Record<string, any>} value @returns {Record<string, any>} */
function stripUndefined(value) {
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry
  }
  return result
}
