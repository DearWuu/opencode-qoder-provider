import { readCallLog, sumCredits } from "./logger.mjs"
import { PROVIDER_ID, PROVIDER_NAME } from "./options.mjs"

/**
 * Parse the sub command out of a `/qoder ...` invocation.
 *
 * Accepts both the raw prompt text ("/qoder refresh") and the bare sub
 * command ("refresh"), so the TUI and the server command share one parser.
 *
 * @param {string} text
 * @returns {string} the sub command, "status" when nothing was given
 */
export function parseSubcommand(text) {
  const parts = (text ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "status"
  const first = (parts[0] ?? "").replace(/^\/+/, "").toLowerCase()
  if (first !== "qoder") return first
  const second = (parts[1] ?? "").replace(/^\/+/, "").toLowerCase()
  return second.length > 0 ? second : "status"
}

/**
 * Short preview of the catalog, used in the status and refresh messages.
 *
 * @param {Array<{ id: string }>} catalog
 * @param {number} [limit]
 * @returns {string}
 */
export function preview(catalog, limit = 6) {
  const shown = catalog.slice(0, limit).map((entry) => `${PROVIDER_ID}/${entry.id}`)
  if (catalog.length > limit) shown.push("…")
  return shown.join(", ")
}

/**
 * Build the `/qoder status` message.
 *
 * Reads the local call log only: no model round trip, no network call.
 *
 * @param {{ cliPath: string, permissionMode: string, timeoutMs: number, logFile: string, cwd?: string }} options
 * @param {Array<{ id: string, modelID: string, name: string }>} catalog
 * @param {string|undefined} discoveryError
 * @param {string|undefined} cliVersion
 * @returns {string}
 */
export function buildStatusText(options, catalog, discoveryError, cliVersion) {
  const lines = [`Qoder provider status (${PROVIDER_ID} / ${PROVIDER_NAME})`]
  lines.push(`- CLI: ${options.cliPath}${cliVersion ? ` (${cliVersion})` : ""}`)
  lines.push(
    discoveryError
      ? `- Auth: unavailable — ${discoveryError}`
      : `- Auth: ok (${catalog.length} models discovered)`,
  )
  lines.push(`- Models: ${catalog.length} (${preview(catalog)})`)
  lines.push(`- Permission mode: ${options.permissionMode}`)
  lines.push(`- Timeout: ${options.timeoutMs} ms`)
  lines.push(`- Working directory: ${options.cwd ?? "(inherited)"}`)
  lines.push(`- Log: ${options.logFile}`)

  const entries = readCallLog(options.logFile, 100_000)
  if (entries.length > 0) {
    const last = entries[entries.length - 1]
    lines.push(
      `- Last call: ${last.ts} model=${last.model ?? "?"} actual=${last.actualModel ?? "?"} ` +
        `credits=${last.credits ?? "?"} duration=${last.durationMs ?? "?"}ms error=${last.isError === true}`,
    )
    lines.push(`- Credits (${entries.length} logged calls): ${sumCredits(entries).toFixed(6)}`)
  } else {
    lines.push("- Last call: none yet")
  }
  return lines.join("\n")
}

/**
 * Build the `/qoder models` message.
 *
 * @param {Array<{ id: string, modelID: string, name: string }>} catalog
 * @param {string|undefined} discoveryError
 * @returns {string}
 */
export function buildModelsText(catalog, discoveryError) {
  const lines = [`Qoder models (${catalog.length})`]
  if (discoveryError) {
    lines.push(`Discovery failed: ${discoveryError}`)
    lines.push("Showing the placeholder catalog; run `/qoder login` and `/qoder refresh` after authenticating.")
  }
  const width = catalog.reduce((max, entry) => Math.max(max, entry.id.length), 0)
  for (const entry of catalog) {
    lines.push(`- ${PROVIDER_ID}/${entry.id.padEnd(width)}  ${entry.name}`)
  }
  return lines.join("\n")
}

/**
 * Build the `/qoder login` message. The plugin never runs the interactive
 * login itself, so it only prints the instructions.
 *
 * @param {string} cliPath
 * @returns {string}
 */
export function buildLoginText(cliPath) {
  return [
    "Authenticate the Qoder CLI (this plugin never runs the interactive login for you):",
    "",
    "1. Open a terminal.",
    `2. Run: ${cliPath} login`,
    "3. Complete the login shown by the CLI.",
    "",
    "Afterwards run `/qoder refresh` to reload the model catalog and `/qoder status` to verify.",
  ].join("\n")
}

/**
 * Build the usage message shown for an unknown sub command.
 *
 * @returns {string}
 */
export function buildUsageText() {
  return [
    "Usage: /qoder <command>",
    "",
    "- status   CLI path, authentication, model count, last call and credits (default)",
    "- refresh  re-discover the models and reload the provider",
    "- models   list the selectable qoder/* model IDs",
    "- login    show how to authenticate the Qoder CLI",
  ].join("\n")
}
