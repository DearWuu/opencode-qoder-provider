import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PROVIDER_ID = "qoder"
export const PROVIDER_NAME = "Qoder (Credits)"

/** Permission mode used when the user does not configure one. Elevated modes require explicit configuration. */
export const DEFAULT_PERMISSION_MODE = "default"

/** Permission modes accepted by `qoderclicn --permission-mode` (see `qoderclicn --help`). */
export const ALLOWED_PERMISSION_MODES = ["default", "accept_edits", "bypass_permissions", "dont_ask", "auto"]

/** Default per-call timeout: 30 minutes. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Context window used to approximate token counts from
 * `usage.context_usage_ratio` (the CLI reports zero token counters).
 * Overridable via the `contextLimit` option.
 */
export const DEFAULT_CONTEXT_LIMIT = 200_000

/**
 * Hard limit of `qoderclicn` 1.1.85 stdin: the CLI truncates the piped prompt at
 * 8388608 bytes and only prints a warning ("Warning: stdin input truncated to
 * 8388608 bytes."). See `atr()` in the CLI bundle.
 */
export const CLI_STDIN_LIMIT_BYTES = 8388608

/**
 * Safety limit used by this provider: strictly below the CLI hard limit so an
 * oversized prompt fails loudly instead of being silently truncated.
 */
export const MAX_PROMPT_BYTES = 7 * 1024 * 1024

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Default JSONL call log location, honouring XDG_STATE_HOME.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultLogFile(env = process.env) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(base, "opencode", "qoder-provider", "calls.jsonl")
}

/**
 * Locate the bundled Qoder CLI, if the dependency was installed next to the plugin.
 *
 * @param {string} [root]
 * @returns {string|undefined}
 */
export function bundledCliPath(root = PACKAGE_ROOT) {
  const candidate = join(root, "node_modules", "@qodercn-ai", "qoderclicn", "bundle", "qoderclicn.js")
  return existsSync(candidate) ? candidate : undefined
}

/**
 * Normalize raw plugin options / env into the runtime options used by the provider.
 *
 * Precedence: explicit option > environment variable > built-in default.
 *
 * @param {Record<string, any>} [raw]
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ cliPath: string, permissionMode: string, timeoutMs: number, contextLimit: number, logFile: string, cwd: string|undefined, additionalDirs: string[], cliTools: string[]|""|undefined }}
 */
export function resolveOptions(raw = {}, env = process.env) {
  const cliPath =
    firstString(raw.cliPath) ??
    firstString(env.QODER_CLI_PATH) ??
    bundledCliPath() ??
    "qoderclicn"

  // A blank environment value counts as unset (some launchers export empty
  // strings); an explicit blank in the raw options is still a hard error.
  const configuredPermissionMode = raw.permissionMode ?? firstString(env.QODER_PERMISSION_MODE) ?? DEFAULT_PERMISSION_MODE
  const permissionMode = typeof configuredPermissionMode === "string" ? configuredPermissionMode.trim() : configuredPermissionMode
  if (typeof permissionMode !== "string" || !ALLOWED_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(
      `Invalid permissionMode "${String(configuredPermissionMode)}". Allowed values: ${ALLOWED_PERMISSION_MODES.join(", ")}.`,
    )
  }

  const configuredTimeout = raw.timeoutMs ?? firstString(env.QODER_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
  const timeoutMs = typeof configuredTimeout === "string" && configuredTimeout.trim().length > 0
    ? Number(configuredTimeout)
    : configuredTimeout
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeoutMs "${String(configuredTimeout)}". Expected a positive number.`)
  }

  const configuredContextLimit = raw.contextLimit ?? DEFAULT_CONTEXT_LIMIT
  const contextLimit = typeof configuredContextLimit === "string" && configuredContextLimit.trim().length > 0
    ? Number(configuredContextLimit)
    : configuredContextLimit
  if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit) || contextLimit <= 0) {
    throw new Error(`Invalid contextLimit "${String(configuredContextLimit)}". Expected a positive number.`)
  }

  const logFile = firstString(raw.logFile) ?? firstString(env.QODER_LOG_FILE) ?? defaultLogFile(env)

  const additionalDirs = raw.additionalDirs ?? []
  if (!Array.isArray(additionalDirs) || !additionalDirs.every((dir) => firstString(dir) !== undefined)) {
    throw new Error("Invalid additionalDirs. Expected an array of non-empty directory paths.")
  }

  const cliTools = raw.cliTools ?? undefined
  if (cliTools !== undefined && cliTools !== "" && !Array.isArray(cliTools)) {
    throw new Error(
      `Invalid cliTools "${String(cliTools)}". Expected an array of tool names or "" to disable all Qoder internal tools.`,
    )
  }
  if (Array.isArray(cliTools) && !cliTools.every((tool) => firstString(tool) !== undefined)) {
    throw new Error(
      `Invalid cliTools. Expected an array of non-empty tool names or "" to disable all Qoder internal tools.`,
    )
  }

  return {
    cliPath,
    permissionMode,
    timeoutMs,
    contextLimit,
    logFile,
    cwd: firstString(raw.cwd),
    additionalDirs: Array.isArray(additionalDirs) ? additionalDirs.map((dir) => String(dir).trim()) : [],
    cliTools,
  }
}

function firstString(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

