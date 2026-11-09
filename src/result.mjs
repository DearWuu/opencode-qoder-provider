/**
 * Extract credit usage and the CLI's accounting keys.
 * `modelUsage` keys are not evidence of the model that served the request.
 */
export function summarizeModelUsage(raw) {
  const modelUsage = raw?.modelUsage && typeof raw.modelUsage === "object" ? raw.modelUsage : {}
  const keys = Object.keys(modelUsage)
  const primaryKey = keys[0]
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
    modelUsage,
  }
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

/** Build the AI SDK V3 usage block (nested input/output token counters). */
export function buildUsage(raw) {
  const summary = summarizeModelUsage(raw)
  const usage = raw?.usage && typeof raw.usage === "object" ? raw.usage : {}

  return {
    inputTokens: {
      total: summary.inputTokens,
      noCache: summary.inputTokens !== undefined && summary.cacheRead !== undefined
        ? Math.max(0, summary.inputTokens - summary.cacheRead)
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
export function buildProviderMetadata({ raw, requestedModel, fallback = undefined }) {
  const summary = summarizeModelUsage(raw)
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
export function buildGenerateResult({ raw, requestedModel }) {
  const isError = raw?.is_error === true
  const text = typeof raw?.result === "string" ? raw.result : ""

  return {
    content: [{ type: "text", text }],
    finishReason: {
      unified: isError ? "error" : "stop",
      raw: typeof raw?.stop_reason === "string" ? raw.stop_reason : isError ? "error" : "end_turn",
    },
    usage: buildUsage(raw),
    warnings: [],
    providerMetadata: {
      qoder: buildProviderMetadata({ raw, requestedModel }),
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
