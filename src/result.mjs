import { modelsEquivalent } from "./models.mjs"

/**
 * Extract the model that actually served the request plus its credit usage.
 * The CLI reports `modelUsage` keyed by the *model key* (e.g. `auto`), while the
 * request carries the display name (e.g. `Auto`).
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
    actualModel: primaryKey,
    credits: numberOrUndefined(primary.credits),
    inputTokens: inputTotal,
    outputTokens: outputTotal,
    cacheRead,
    cacheWrite,
    modelUsage,
  }
}

/**
 * Detect a server side model fallback.
 * Comparison ignores case (and punctuation) so `Auto` matches `modelUsage.auto`.
 */
export function detectFallback(requestedModel, modelUsage) {
  const keys = Object.keys(modelUsage && typeof modelUsage === "object" ? modelUsage : {})
  if (keys.length === 0) return { fellBack: false, actualModel: undefined }
  if (typeof requestedModel !== "string" || requestedModel.trim().length === 0) {
    return { fellBack: false, actualModel: keys[0] }
  }
  for (const key of keys) {
    if (modelsEquivalent(requestedModel, key)) {
      return { fellBack: false, actualModel: key }
    }
  }
  return { fellBack: true, actualModel: keys[0] }
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
export function buildProviderMetadata({ raw, requestedModel, fallback }) {
  const summary = summarizeModelUsage(raw)
  const metadata = {
    sessionId: raw?.session_id,
    uuid: raw?.uuid,
    credits: numberOrUndefined(raw?.total_credits),
    totalCredits: numberOrUndefined(raw?.total_credits),
    modelCredits: summary.credits,
    requestedModel,
    actualModel: fallback?.actualModel ?? summary.actualModel,
    modelFallback: fallback?.fellBack === true,
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
 *
 * A server side model fallback keeps the answer but appends a visible warning.
 */
export function buildGenerateResult({ raw, requestedModel }) {
  const isError = raw?.is_error === true
  const fallback = detectFallback(requestedModel, raw?.modelUsage)
  const warnings = []

  let text = typeof raw?.result === "string" ? raw.result : ""
  if (fallback.fellBack) {
    const message = `Qoder model fallback: requested "${requestedModel}" was served by "${fallback.actualModel}".`
    warnings.push({ type: "other", message })
    text = text.length > 0 ? `${text}\n\n> ⚠️ ${message}` : `> ⚠️ ${message}`
  }

  return {
    content: [{ type: "text", text }],
    finishReason: {
      unified: isError ? "error" : "stop",
      raw: typeof raw?.stop_reason === "string" ? raw.stop_reason : isError ? "error" : "end_turn",
    },
    usage: buildUsage(raw),
    warnings,
    providerMetadata: {
      qoder: buildProviderMetadata({ raw, requestedModel, fallback }),
    },
  }
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stripUndefined(value) {
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry
  }
  return result
}
