/**
 * Mapping between Qoder CLI model names and OpenCode model IDs.
 *
 * OpenCode IDs are lowercase kebab-case, the Qoder `modelID` keeps the original
 * CLI value (`Auto`, `Qwen3.8-Max`, ...) so it can be passed to `--model`.
 */

/** Convert a Qoder model name into an OpenCode (lowercase kebab-case) model ID. */
export function toModelId(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

/**
 * Parse the output of `qoderclicn --list-models`.
 *
 * The CLI prints a `MODEL` header followed by one line per model. Models that do
 * not come from the built-in `qoder` source are printed as `display (key)`.
 */
export function parseModelList(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const entries = []
  for (const line of lines) {
    if (entries.length === 0 && line.toUpperCase() === "MODEL") continue
    entries.push(parseModelEntry(line))
  }
  return entries
}

/** Split one `--list-models` line into its display name and the model key. */
export function parseModelEntry(line) {
  const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(line)
  if (match && match[1].trim().length > 0) {
    return { name: match[1].trim(), modelID: match[2].trim() }
  }
  return { name: line, modelID: line }
}

/**
 * Build the OpenCode model catalog from the Qoder model list.
 * Duplicate IDs (two Qoder names that normalize to the same ID) get a numeric suffix.
 */
export function buildModelCatalog(entries) {
  const used = new Map()
  return entries.map((entry) => {
    const base = toModelId(entry.modelID) || toModelId(entry.name) || "model"
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    const id = seen === 0 ? base : `${base}-${seen + 1}`
    return { id, modelID: entry.modelID, name: entry.name }
  })
}

/**
 * Compare two model identifiers ignoring case.
 *
 * Qoder reports the *key* of the model that actually served the request
 * (`modelUsage.auto`) while the request carries the display name (`Auto`), so a
 * plain string comparison would report a bogus fallback.
 */
export function modelsEquivalent(requested, actual) {
  if (typeof requested !== "string" || typeof actual !== "string") return false
  const left = requested.trim().toLowerCase()
  const right = actual.trim().toLowerCase()
  if (left.length === 0 || right.length === 0) return false
  if (left === right) return true
  // Fall back to a punctuation-insensitive comparison ("Qwen3.8-Max" vs "qwen3.8max").
  return stripPunctuation(left) === stripPunctuation(right)
}

function stripPunctuation(value) {
  return value.replace(/[^a-z0-9]/g, "")
}
