/**
 * 文件职责：provider 选项与环境变量的规范化（CLI 路径、权限模式、超时、上下文窗口、日志路径、工具清单、倍率缓存与抓取超时）及默认值。
 * 上游：index.ts、provider.mjs、src/provider、src/catalog、scripts/check-real-catalog.mjs。
 * 下游：node:fs/os/path/url、src/pricing（倍率 TTL 与抓取超时默认值）。
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { PRICING_TIMEOUT_MS, PRICING_TTL_MS } from "./pricing.mjs"

export const PROVIDER_ID = "qoder"
export const PROVIDER_NAME = "Qoder (Credits)"

/**
 * 用户未配置时使用的权限模式：默认放开 Qoder CLI 内层权限，
 * 不再逐项确认文件修改与命令执行；用户显式配置其他合法模式仍按其值透传。
 */
export const DEFAULT_PERMISSION_MODE = "bypass_permissions"

/** `qoderclicn --permission-mode` 接受的模式（见 `qoderclicn --help`）。 */
export const ALLOWED_PERMISSION_MODES = ["default", "accept_edits", "bypass_permissions", "dont_ask", "auto"]

/** 单次调用默认总超时：30 分钟。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** 两次 stdout/stderr 活动之间允许的默认静默时长：3 分钟。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 180_000

/**
 * 由 `usage.context_usage_ratio` 近似 token 数时使用的上下文窗口
 * （CLI 上报的 token 计数恒为 0）。可由 `contextLimit` 选项覆盖。
 */
export const DEFAULT_CONTEXT_LIMIT = 200_000

/**
 * `qoderclicn` 1.1.85 的 stdin 硬上限：CLI 在 8388608 字节处截断管道输入，
 * 且只打印一行 warning（"Warning: stdin input truncated to 8388608 bytes."）。
 * 见 CLI bundle 里的 `atr()`。
 */
export const CLI_STDIN_LIMIT_BYTES = 8388608

/**
 * 本 provider 使用的安全上限：严格低于 CLI 硬上限，
 * 让超大 prompt 明确报错，而不是被静默截断。
 */
export const MAX_PROMPT_BYTES = 7 * 1024 * 1024

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * 默认 JSONL 调用日志位置，遵循 XDG_STATE_HOME。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function defaultLogFile(env = process.env) {
  const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(base, "opencode", "qoder-provider", "calls.jsonl")
}

/**
 * 定位插件随依赖安装的 Qoder CLI（若有）。
 *
 * @param {string} [root]
 * @returns {string|undefined}
 */
export function bundledCliPath(root = PACKAGE_ROOT) {
  const candidate = join(root, "node_modules", "@qodercn-ai", "qoderclicn", "bundle", "qoderclicn.js")
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 把原始插件选项 / 环境变量规范化为 provider runtime 选项。
 *
 * 优先级：显式选项 > 环境变量 > 内置默认值。
 *
 * 调用方：index.ts 的 setup、provider.mjs 的 model()、src/provider 的 createQoder。
 *
 * @param {Record<string, any>} [raw]
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ cliPath: string, permissionMode: string, timeoutMs: number, idleTimeoutMs: number, contextLimit: number, pricingTtlMs: number, pricingTimeoutMs: number, logFile: string, cwd: string|undefined, additionalDirs: string[], cliTools: string[]|""|undefined }}
 */
export function resolveOptions(raw = {}, env = process.env) {
  const cliPath =
    firstString(raw.cliPath) ??
    firstString(env.QODER_CLI_PATH) ??
    bundledCliPath() ??
    "qoderclicn"

  // 空白的环境变量值视同未设置（有些启动器会导出空串）；
  // 而 raw 选项里显式给出空值仍然是硬错误。
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

  const configuredIdleTimeout = raw.idleTimeoutMs ?? firstString(env.QODER_IDLE_TIMEOUT_MS) ?? DEFAULT_IDLE_TIMEOUT_MS
  const idleTimeoutMs = typeof configuredIdleTimeout === "string" && configuredIdleTimeout.trim().length > 0
    ? Number(configuredIdleTimeout)
    : configuredIdleTimeout
  if (typeof idleTimeoutMs !== "number" || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error(`Invalid idleTimeoutMs "${String(configuredIdleTimeout)}". Expected a positive number.`)
  }

  const configuredContextLimit = raw.contextLimit ?? DEFAULT_CONTEXT_LIMIT
  const contextLimit = typeof configuredContextLimit === "string" && configuredContextLimit.trim().length > 0
    ? Number(configuredContextLimit)
    : configuredContextLimit
  if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit) || contextLimit <= 0) {
    throw new Error(`Invalid contextLimit "${String(configuredContextLimit)}". Expected a positive number.`)
  }

  const configuredPricingTtl = raw.pricingTtlMs ?? firstString(env.QODER_PRICING_TTL_MS) ?? PRICING_TTL_MS
  const pricingTtlMs = typeof configuredPricingTtl === "string" && configuredPricingTtl.trim().length > 0
    ? Number(configuredPricingTtl)
    : configuredPricingTtl
  if (typeof pricingTtlMs !== "number" || !Number.isFinite(pricingTtlMs) || pricingTtlMs <= 0) {
    throw new Error(`Invalid pricingTtlMs "${String(configuredPricingTtl)}". Expected a positive number.`)
  }

  const configuredPricingTimeout = raw.pricingTimeoutMs ?? firstString(env.QODER_PRICING_TIMEOUT_MS) ?? PRICING_TIMEOUT_MS
  const pricingTimeoutMs = typeof configuredPricingTimeout === "string" && configuredPricingTimeout.trim().length > 0
    ? Number(configuredPricingTimeout)
    : configuredPricingTimeout
  if (typeof pricingTimeoutMs !== "number" || !Number.isFinite(pricingTimeoutMs) || pricingTimeoutMs <= 0) {
    throw new Error(`Invalid pricingTimeoutMs "${String(configuredPricingTimeout)}". Expected a positive number.`)
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
    idleTimeoutMs,
    contextLimit,
    pricingTtlMs,
    pricingTimeoutMs,
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

