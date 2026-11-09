/**
 * Extract credit usage and the CLI's accounting keys.
 * `modelUsage` keys are not evidence of the model that served the request.
 *
 * The primary entry is the first `modelUsage` entry that actually accounted
 * for something (credits > 0 or any non-zero token counter). The CLI can
 * emit an all-zero `auto` entry next to the real `fast` entry; key order
 * alone would then report zero usage.
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
 * Read `usage.context_usage_ratio` (fallback: top level). The CLI 1.1.85 sets
 * every token counter to 0 but keeps this ratio truthful.
 *
 * @param {any} raw
 * @returns {number|undefined} a ratio in (0, 1], undefined when absent or invalid
 */
export function readContextUsageRatio(raw) {
  for (const value of [raw?.usage?.context_usage_ratio, raw?.context_usage_ratio]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) return value
  }
  return undefined
}

/** `stop_reason` values that mean the output hit its token length limit. */
const LENGTH_STOP_REASONS = new Set(["max_tokens", "max-output-tokens"])

/** Map the CLI `stop_reason` onto the unified finish reason. */
export function toUnifiedFinishReason(raw) {
  if (raw?.is_error === true) return "error"
  return LENGTH_STOP_REASONS.has(raw?.stop_reason) ? "length" : "stop"
}

/**
 * Pick the `modelUsage` key that carries the real accounting: credits > 0 or
 * any non-zero token counter. Falls back to the first key when no entry
 * qualifies (all-zero accounting still reports the CLI's own ordering).
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

/** Detect only an explicit model fallback message written by the CLI to stderr. */
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
 * Resolve the input-token total shown to the UI.
 * Real non-zero counters win; a missing/zero counter plus a valid
 * `context_usage_ratio` yields an approximation of `ratio * contextLimit`.
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

/** Build the AI SDK V3 usage block (nested input/output token counters). */
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

/** Build `providerMetadata.qoder` from the CLI result. */
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
 * Convert a raw CLI result into an AI SDK V3 generate result.
 * Explicit fallbacks are rejected by `execute` before reaching this conversion.
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
