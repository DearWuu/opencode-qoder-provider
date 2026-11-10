/**
 * 文件职责：spawn Qoder CLI、写入 stdin、按字节上限收集输出、超时/中断时终止整个进程树。
 * 上游：src/provider.execute、src/catalog（`--list-models` / `--version`）。
 * 下游：node:child_process。
 */
import { spawn } from "node:child_process"

/** 单次 CLI 运行保留的 stdout 字节上限。 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024
/** 单次 CLI 运行保留的 stderr 字节上限。 */
export const MAX_STDERR_BYTES = 8 * 1024

/**
 * 为单次补全构建 Qoder CLI 参数。
 *
 * 刻意不传 `--input-format`：`qoderclicn` 1.1.85 只在输出格式同为 `stream-json` 时才接受
 * `--input-format=stream-json`（否则报 "--input-format=stream-json requires output-format=stream-json."）。
 * 因此 prompt 以纯文本写入 stdin。
 *
 * `stream: true` 切换为 `-o stream-json --include-partial-messages`
 * （隐藏参数，已在 1.1.85 bundle 上验证）：CLI 随后逐行输出 JSON 事件，带真实的 `text_delta` 增量。
 *
 * `cliTools` 语义：`undefined` 保留 CLI 默认工具；`""` 或 `[]` 禁用全部内置工具（`--tools ""`）；
 * 非空数组为允许清单。`maxOutputTokens` 仅在为正整数时透传，其他值一律忽略（不传 flag），
 * 保证调用方传入的非法值不会破坏调用。
 *
 * @param {{ modelID?: string, cwd?: string, permissionMode?: string, additionalDirs?: string[], cliTools?: string[] | "", maxOutputTokens?: number, stream?: boolean }} [options]
 * @returns {string[]}
 */
export function buildCliArgs({ modelID, cwd, permissionMode, additionalDirs, cliTools, maxOutputTokens, stream } = {}) {
  const args = stream
    ? ["-p", "-o", "stream-json", "--include-partial-messages"]
    : ["-p", "-o", "json"]
  if (permissionMode) args.push("--permission-mode", permissionMode)
  args.push("--no-session-persistence")
  if (cwd) args.push("--cwd", cwd)
  if (modelID) args.push("--model", modelID)
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
    args.push("--max-output-tokens", String(maxOutputTokens))
  }
  for (const dir of additionalDirs ?? []) args.push("--add-dir", dir)
  // `--tools` 在 CLI 里是变长参数，必须放在最后：它会把后面每个裸参数都吃成工具名。
  if (Array.isArray(cliTools)) {
    // 非空数组是允许清单；空数组禁用全部内置工具，效果等同 ""。
    args.push("--tools", ...(cliTools.length > 0 ? cliTools : [""]))
  } else if (cliTools === "") {
    args.push("--tools", "")
  }
  return args
}

/**
 * spawn Qoder CLI 并收集其输出。
 *
 * 调用方：src/provider.execute、src/catalog（`--list-models` / `--version`）。
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] 要 spawn 的可执行文件。
 * @param {string[]} [options.args] 传给 CLI 的参数。
 * @param {string} [options.input] 写入 stdin 的文本。
 * @param {string} [options.cwd] CLI 进程的工作目录。
 * @param {number} [options.timeoutMs] 从 spawn 起超过该总毫秒数后终止整个进程树。
 * @param {number} [options.idleTimeoutMs] stdout/stderr 静默超过该毫秒数后终止整个进程树。
 * @param {AbortSignal} [options.signal] 中止运行并终止整个进程树。
 * @param {(chunk: Buffer) => void} [options.onStdout] 每个原始 stdout chunk 到达时调用，早于字节上限裁剪。
 * @param {boolean} [options.collectStdout=true] 是否保留原始 stdout 副本。为 false 时既不分配也不解码
 *   32 MiB 捕获缓冲；`stdout` 返回 ""，只有截断标志继续统计字节数（onStdout 照常触发）。
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, durationMs: number, timedOut: boolean, timeoutKind: "idle"|"total"|undefined, aborted: boolean, stdoutTruncated: boolean, stderrTruncated: boolean, lastEventType: string, lastEventAgoMs: number, sawStdout: boolean, sawStderr: boolean }>}
 */
export function runCli({ cliPath, args, input, cwd, timeoutMs, idleTimeoutMs, signal, onStdout, collectStdout = true, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(cliPath, args, {
        cwd: cwd || undefined,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      })
    } catch (error) {
      reject(toSpawnError(error, cliPath))
      return
    }

    // 固定容量缓冲区：即使单个 chunk 超出上限，保留内存也有界。
    const stdoutBuffer = collectStdout ? Buffer.allocUnsafe(MAX_STDOUT_BYTES) : undefined
    const stderrBuffer = Buffer.allocUnsafe(MAX_STDERR_BYTES)
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timeoutKind
    let aborted = false
    let settled = false
    let sawStdout = false
    let sawStderr = false
    let lastEventType = "spawn"
    let lastEventAt = startedAt
    let idleTimer
    let totalTimer

    const expire = (kind) => {
      if (settled || aborted || timeoutKind !== undefined) return
      timeoutKind = kind
      killTree(child)
    }
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = idleTimeoutMs && idleTimeoutMs > 0
        ? setTimeout(() => expire("idle"), idleTimeoutMs)
        : undefined
    }
    const noteActivity = (type) => {
      if (settled) return
      if (type === "stdout") sawStdout = true
      if (type === "stderr") sawStderr = true
      lastEventType = type
      lastEventAt = Date.now()
      armIdleTimer()
    }

    totalTimer = timeoutMs && timeoutMs > 0 ? setTimeout(() => expire("total"), timeoutMs) : undefined
    armIdleTimer()

    const onAbort = () => {
      if (settled || aborted) return
      aborted = true
      killTree(child)
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      if (signal) signal.removeEventListener("abort", onAbort)
    }

    child.stdout.on("data", (chunk) => {
      noteActivity("stdout")
      if (onStdout) {
        try {
          onStdout(chunk)
        } catch {
          // 流消费者出错不能拖垮原始捕获。
        }
      }
      const kept = Math.min(chunk.length, MAX_STDOUT_BYTES - stdoutBytes)
      if (kept > 0) {
        if (stdoutBuffer) chunk.copy(stdoutBuffer, stdoutBytes, 0, kept)
        stdoutBytes += kept
      }
      if (kept < chunk.length) stdoutTruncated = true
    })

    child.stderr.on("data", (chunk) => {
      noteActivity("stderr")
      const kept = Math.min(chunk.length, MAX_STDERR_BYTES - stderrBytes)
      if (kept > 0) {
        chunk.copy(stderrBuffer, stderrBytes, 0, kept)
        stderrBytes += kept
      }
      if (kept < chunk.length) stderrTruncated = true
    })

    child.on("error", (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(toSpawnError(error, cliPath))
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        code,
        stdout: stdoutBuffer ? stdoutBuffer.subarray(0, stdoutBytes).toString("utf8") : "",
        stderr: stderrBuffer.subarray(0, stderrBytes).toString("utf8"),
        durationMs: Date.now() - startedAt,
        timedOut: timeoutKind !== undefined,
        timeoutKind,
        aborted,
        stdoutTruncated,
        stderrTruncated,
        lastEventType,
        lastEventAgoMs: Math.max(0, Date.now() - lastEventAt),
        sawStdout,
        sawStderr,
      })
    })

    if (child.stdin) {
      child.stdin.on("error", () => {
        // CLI 可能在 prompt 写完前就退出；真正的失败由 close 处理器上报。
      })
      if (input !== undefined && input !== null) {
        child.stdin.write(input)
      }
      child.stdin.end()
    }
  })
}

/**
 * 从 CLI stdout 里取出 JSON 结果文档。
 * CLI 只打印一个 JSON 对象，但它前面可能还有 warning。
 *
 * @param {string} stdout
 * @returns {Record<string, any>}
 */
export function parseCliResult(stdout) {
  const text = String(stdout ?? "").trim()
  if (!text) {
    throw new Error("Qoder CLI returned no output.")
  }

  const direct = tryParse(text)
  if (direct && typeof direct === "object") return direct

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = tryParse(lines[index])
    if (parsed && typeof parsed === "object") return parsed
  }

  throw new Error(`Qoder CLI did not return a JSON result. Output started with: ${text.slice(0, 200)}`)
}

/** 终止 CLI 及其派生的所有进程。 */
export function killTree(child, { platform = process.platform, spawnProcess = spawn } = {}) {
  if (!child || !child.pid) return
  const fallback = () => {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
  if (platform === "win32") {
    try {
      const taskkill = spawnProcess("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" })
      taskkill.once("error", fallback)
    } catch {
      fallback()
    }
    return
  }
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    fallback()
  }
}

function tryParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function toSpawnError(error, cliPath) {
  const cause = error instanceof Error ? error : new Error(String(error))
  const hint = cause.code === "ENOENT"
    ? `Qoder CLI not found at "${cliPath}". Install it with "npm i @qodercn-ai/qoderclicn@1.1.85" or set QODER_CLI_PATH.`
    : `Failed to start the Qoder CLI at "${cliPath}".`
  const wrapped = new Error(`${hint} ${cause.message}`)
  wrapped.cause = cause
  return wrapped
}
