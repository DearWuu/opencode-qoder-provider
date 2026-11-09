import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const PROVIDER_ID = "qoder"
export const PROVIDER_NAME = "Qoder (Credits)"

/** Permission mode used when the user does not configure one. Never `bypass_permissions`. */
export const DEFAULT_PERMISSION_MODE = "accept_edits"

/** Permission modes accepted by `qoderclicn --permission-mode` (see `qoderclicn --help`). */
export const ALLOWED_PERMISSION_MODES = ["default", "accept_edits", "bypass_permissions", "dont_ask", "auto"]

/** Default per-call timeout: 30 minutes. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

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
 * @returns {{ cliPath: string, permissionMode: string, timeoutMs: number, logFile: string, cwd: string|undefined }}
 */
export function resolveOptions(raw = {}, env = process.env) {
  const cliPath =
    firstString(raw.cliPath) ??
    firstString(env.QODER_CLI_PATH) ??
    bundledCliPath() ??
    "qoderclicn"

  const permissionMode = firstString(raw.permissionMode) ?? firstString(env.QODER_PERMISSION_MODE) ?? DEFAULT_PERMISSION_MODE
  if (!ALLOWED_PERMISSION_MODES.includes(permissionMode)) {
    throw new Error(
      `Invalid permissionMode "${permissionMode}". Allowed values: ${ALLOWED_PERMISSION_MODES.join(", ")}.`,
    )
  }

  const timeoutMs = firstNumber(raw.timeoutMs) ?? firstNumber(env.QODER_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeoutMs "${raw.timeoutMs ?? env.QODER_TIMEOUT_MS}". Expected a positive number.`)
  }

  const logFile = firstString(raw.logFile) ?? firstString(env.QODER_LOG_FILE) ?? defaultLogFile(env)

  return {
    cliPath,
    permissionMode,
    timeoutMs,
    logFile,
    cwd: firstString(raw.cwd),
  }
}

function firstString(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function firstNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}
