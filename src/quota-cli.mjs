/**
 * 文件职责：通过跨平台 node-pty 启动已安装 Qoder CLI，自动通过 trust 页并只发送 `/usage`。
 * 上游：src/quota.createQuotaStore 的默认 readUsage。
 * 下游：node-pty 与 Qoder CLI；不读取/解密 token，不调用 Bearer HTTP API，不发送模型 prompt。
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { killTree } from "./cli.mjs"

export const DEFAULT_QUOTA_TIMEOUT_MS = 60_000
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024
const BRIDGE_GRACE_MS = 5_000
const MAX_BRIDGE_BYTES = 8 * 1024 * 1024

/**
 * 读取一次官方交互式 `/usage` 屏幕。
 * 除 trust 页的 Enter 外，唯一写入 CLI 的文本是 `/usage\r`；取得输出或失败后立即销毁 PTY。
 *
 * @param {{ cliPath: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal,
 *   spawnPty?: (file: string, args: string[], options: Record<string, any>) => any,
 *   env?: Record<string, string | undefined>, platform?: NodeJS.Platform,
 *   timing?: { trustDelayMs?: number, initialDelayMs?: number, settleDelayMs?: number, watchdogIntervalMs?: number } }} options
 * @returns {Promise<string>}
 */
export async function readOfficialUsage(options) {
  // Bun 下 node-pty 会立即退出且不产生任何输出（实测 1.4.4）；交给同一插件自带的 Node 桥接执行。
  if (!options.spawnPty && isBunRuntime()) return readOfficialUsageViaNode(options)
  return readOfficialUsageWithPty(options)
}

async function readOfficialUsageWithPty(options) {
  const spawnPty = options.spawnPty ?? (await import("node-pty")).spawn
  const command = ptyCommand(options.cliPath, options.platform ?? process.platform, options.env ?? process.env)
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS
  const timing = {
    trustDelayMs: options.timing?.trustDelayMs ?? 6_000,
    initialDelayMs: options.timing?.initialDelayMs ?? 12_000,
    settleDelayMs: options.timing?.settleDelayMs ?? 1_500,
    watchdogIntervalMs: options.timing?.watchdogIntervalMs ?? 100,
  }
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnPty(command.file, command.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: options.cwd || undefined,
        env: { ...(options.env ?? process.env), TERM: "xterm-256color", COLORTERM: "truecolor" },
      })
    } catch (error) {
      reject(error)
      return
    }

    const startedAt = Date.now()
    let output = ""
    let trustedAt
    let usageSentAt
    let settleTimer
    let watchdog
    let finished = false
    let dataDisposable
    let exitDisposable

    const cleanup = () => {
      clearInterval(watchdog)
      if (settleTimer) clearTimeout(settleTimer)
      dataDisposable?.dispose()
      exitDisposable?.dispose()
      options.signal?.removeEventListener("abort", onAbort)
    }
    const finish = (error) => {
      if (finished) return
      finished = true
      cleanup()
      try {
        child.kill()
      } catch {}
      if (error) reject(error)
      else resolve(output)
    }
    const onAbort = () => {
      const error = new Error("Qoder CLI /usage was aborted.")
      error.name = "AbortError"
      finish(error)
    }

    dataDisposable = child.onData((chunk) => {
      if (finished) return
      output = `${output}${chunk}`.slice(-MAX_OUTPUT_CHARS)
      const compact = stripForMatch(output)
      if (trustedAt === undefined && compact.includes("Doyoutrustthefilesinthisfolder?")) {
        trustedAt = Date.now()
        child.write("\r")
      }
      if (usageSentAt === undefined) return
      if (hasCompleteQuota(compact) || /Unknowncommand|Notloggedin|Pleaselogin|Loginrequired/i.test(compact)) {
        finish()
        return
      }
      // 缺字段的企业/个人套餐也应及时落为 unavailable，而不是无意义地等到总超时。
      if (!settleTimer && compact.includes("QoderCNPlan:")) {
        settleTimer = setTimeout(() => finish(), timing.settleDelayMs)
      }
    })
    exitDisposable = child.onExit(() => finish())

    watchdog = setInterval(() => {
      const elapsed = Date.now() - startedAt
      if (elapsed >= timeoutMs) {
        finish(new Error(`Qoder CLI /usage timed out after ${timeoutMs} ms.`))
        return
      }
      const readyAfterTrust = trustedAt !== undefined && Date.now() - trustedAt >= timing.trustDelayMs
      const readyWithoutTrust = trustedAt === undefined && elapsed >= timing.initialDelayMs
      if (usageSentAt === undefined && (readyAfterTrust || readyWithoutTrust)) {
        usageSentAt = Date.now()
        child.write("/usage\r")
      }
    }, timing.watchdogIntervalMs)

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/**
 * Bun 运行时通过 Node 子进程执行同一 PTY 读取逻辑。
 * 父进程只传 CLI 路径、cwd、超时和节奏；输出以 JSON 回传，避免把终端控制字符混进插件内存。
 */
function readOfficialUsageViaNode(options) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS
  const helper = fileURLToPath(new URL("./quota-pty.mjs", import.meta.url))
  const request = JSON.stringify({
    cliPath: options.cliPath,
    cwd: options.cwd,
    timeoutMs,
    timing: options.timing,
    platform,
  })

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(defaultJsRuntime(env), [helper], {
        cwd: options.cwd || undefined,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: platform !== "win32",
      })
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ""
    let stderr = ""
    let finished = false
    let timer
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const finish = (error, output) => {
      if (finished) return
      finished = true
      cleanup()
      killTree(child, { platform })
      if (error) reject(error)
      else resolve(output)
    }
    const onAbort = () => {
      const error = new Error("Qoder CLI /usage was aborted.")
      error.name = "AbortError"
      finish(error)
    }

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      if (finished) return
      stdout += chunk
      if (Buffer.byteLength(stdout) > MAX_BRIDGE_BYTES) finish(new Error("Node quota helper output exceeded the 8 MiB cap."))
    })
    child.stderr.on("data", (chunk) => {
      if (finished) return
      stderr = `${stderr}${chunk}`.slice(-8_192)
    })
    child.on("error", (error) => finish(error))
    child.on("exit", (code, signal) => {
      if (finished) return
      const payload = parseBridgePayload(stdout)
      if (payload?.ok) {
        finish(undefined, payload.output)
        return
      }
      const detail = payload?.error || stderr.trim() || `Node quota helper exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`
      finish(new Error(detail))
    })
    timer = setTimeout(() => {
      finish(new Error(`Qoder CLI /usage timed out after ${timeoutMs} ms.`))
    }, timeoutMs + BRIDGE_GRACE_MS)
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
    child.stdin.on("error", () => {})
    child.stdin.end(request)
  })
}

function parseBridgePayload(value) {
  try {
    const payload = JSON.parse(value)
    if (typeof payload?.output === "string") return { ok: true, output: payload.output }
    return { ok: false, error: typeof payload?.error === "string" ? payload.error : "" }
  } catch {
    return undefined
  }
}

export function isBunRuntime() {
  return typeof globalThis.Bun !== "undefined"
}

function defaultJsRuntime(env) {
  const configured = env.QODER_NODE_PATH?.trim()
  if (configured) return configured
  const executable = process.execPath.split(/[\\/]/).at(-1) ?? ""
  if (/^node(?:\.exe)?$/i.test(executable)) return process.execPath
  // node-pty 不保证按 PATH 解析裸命令；显式找绝对路径，找不到时仍交给调用方报 unavailable。
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue
    for (const name of ["node", "node.exe"]) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return "node"
}

/**
 * JS bundle 用 Node 启动，避免依赖 PATHEXT 或 shell 关联。
 * OpenCode 插件运行时是 Bun，此时 process.execPath 指向 opencode 自身，不能拿它跑 JS。
 */
export function ptyCommand(cliPath, platform = process.platform, env = process.env, runtime = defaultJsRuntime(env)) {
  const args = ["--permission-mode", "default"]
  if ([".js", ".mjs", ".cjs"].includes(extname(cliPath).toLowerCase())) {
    return { file: runtime, args: [cliPath, ...args] }
  }
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(cliPath)) {
    return {
      file: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${cliPath}" --permission-mode default`],
    }
  }
  return { file: cliPath, args }
}

function hasCompleteQuota(compact) {
  return compact.includes("PlanExpiresAt:") &&
    /(?:OrgResourcePackage|PlanCreditsUsed|Add-onCreditsUsed):[\d,]+(?:\.\d+)?\/[\d,]+(?:\.\d+)?/.test(compact)
}

function stripForMatch(value) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/\s+/g, "")
}
