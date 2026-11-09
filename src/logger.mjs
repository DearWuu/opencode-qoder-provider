import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Append one call record to the JSONL log.
 *
 * The log never contains the prompt, the prompt answer or any credential:
 * only the model, the credit consumption and the outcome.
 *
 * @param {string} file
 * @param {Record<string, any>} entry
 * @returns {void}
 */
export function appendCallLog(file, entry) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // Logging must never break a model call.
  }
}

/**
 * Build the JSONL record for a single Qoder call.
 *
 * @param {object} entry
 * @param {string} entry.requestedModel
 * @param {string} [entry.actualModel]
 * @param {number} [entry.credits]
 * @param {number} [entry.durationMs]
 * @param {boolean} [entry.isError]
 * @param {number|null} [entry.exitCode]
 * @param {string} [entry.sessionId]
 * @param {boolean} [entry.timedOut]
 * @param {boolean} [entry.aborted]
 * @param {boolean} [entry.modelFallback]
 * @returns {Record<string, any>}
 */
export function buildLogEntry({ requestedModel, actualModel, credits, durationMs, isError, exitCode, sessionId, timedOut, aborted, modelFallback }) {
  const entry = {
    ts: new Date().toISOString(),
    provider: "qoder",
    model: requestedModel,
    actualModel,
    modelFallback,
    credits,
    durationMs,
    isError,
    exitCode,
    sessionId,
    timedOut,
    aborted,
  }
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key]
  }
  return entry
}

/**
 * Read the last entries of the JSONL call log.
 * Used by `/qoder status` to show the most recent call without a model round trip.
 *
 * @param {string} file
 * @param {number} [limit]
 * @returns {Array<Record<string, any>>}
 */
export function readCallLog(file, limit = 5) {
  if (!file) return []
  let content
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const entries = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // Ignore corrupted lines instead of failing the status command.
    }
  }
  return entries.slice(-limit)
}

/**
 * Sum the credits of all logged calls.
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {number}
 */
export function sumCredits(entries) {
  let total = 0
  for (const entry of entries) {
    if (typeof entry?.credits === "number" && Number.isFinite(entry.credits)) total += entry.credits
  }
  return total
}
