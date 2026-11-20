/**
 * 文件职责：spawn Qoder CLI、把图片附件落成临时文件并以 `--attachment` 传入、写入 stdin、按字节上限收集输出、超时/中断时终止整个进程树；
 * 工具桥接模式在参数层追加 `--append-system-prompt` / `--strict-mcp-config` / `--tools ""`。
 * 上游：src/provider.execute、src/catalog（`--list-models` / `--version`）。
 * 下游：node:child_process、node:fs/os/path（附件临时目录）。
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** 单次 CLI 运行保留的 stdout 字节上限。 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024
/** 单次 CLI 运行保留的 stderr 字节上限。 */
export const MAX_STDERR_BYTES = 8 * 1024

/** Qoder CLI 真实的思考强度枚举（`--reasoning-effort` 实测取值）。 */
export const REASONING_EFFORTS = ["auto", "none", "low", "medium", "high", "xhigh", "max", "ultracode"]

/** 判断取值是否是 CLI 接受的思考强度。 */
export function isReasoningEffort(value) {
  return typeof value === "string" && REASONING_EFFORTS.includes(value)
}

/** 附件临时文件的扩展名映射；未知类型用 `.bin`，由 CLI 按内容识别。 */
const ATTACHMENT_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

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
 * `appendSystemPrompt` 非空时追加 `--append-system-prompt <text>`：宿主 system 消息与
 * 工具桥接协议都从这里进入 CLI，不混进 stdin 的用户文本。
 *
 * `bridge: true` 是工具桥接模式：再追加 `--strict-mcp-config`（屏蔽用户级 MCP），
 * 并用 `--tools ""` **强制**关闭全部内置工具，让 CLI 退化成纯文本模型、只通过文本信封
 * 请求宿主执行工具。桥接模式优先于 `cliTools`：即使配置了允许清单，内置工具也必须关闭，
 * 否则 CLI 会自己执行工具而宿主收不到调用。
 * `reasoningEffort` 为真实枚举且不是 `auto` 时追加 `--reasoning-effort <value>`；
 * `auto`、`undefined` 与非法值都不传 flag（默认档位由 CLI 决定）。
 *
 * 参数顺序固定为：常规参数 → `--append-system-prompt` → `--reasoning-effort` →
 * `--strict-mcp-config` → `--add-dir` → 附件（`runCli` 插入）→ `--tools ""` 收尾。
 *
 * @param {{ modelID?: string, cwd?: string, permissionMode?: string, additionalDirs?: string[], cliTools?: string[] | "", maxOutputTokens?: number, stream?: boolean, bridge?: boolean, appendSystemPrompt?: string, reasoningEffort?: string }} [options]
 * @returns {string[]}
 */
export function buildCliArgs({ modelID, cwd, permissionMode, additionalDirs, cliTools, maxOutputTokens, stream, bridge, appendSystemPrompt, reasoningEffort } = {}) {
  const bridging = bridge === true
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
  if (typeof appendSystemPrompt === "string" && appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", appendSystemPrompt)
  }
  if (isReasoningEffort(reasoningEffort) && reasoningEffort !== "auto") {
    args.push("--reasoning-effort", reasoningEffort)
  }
  if (bridging) {
    args.push("--strict-mcp-config")
  }
  for (const dir of additionalDirs ?? []) args.push("--add-dir", dir)
  // `--tools` 在 CLI 里是变长参数，必须放在最后：它会把后面每个裸参数都吃成工具名。
  if (bridging) {
    args.push("--tools", "")
  } else if (Array.isArray(cliTools)) {
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
 * `attachments` 里的每个图片在 spawn 前写成临时文件并追加 `--attachment <path>`；
 * 临时目录在成功、失败、超时、中断四条路径上都会删除（`finally` 语义）。
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] 要 spawn 的可执行文件。
 * @param {string[]} [options.args] 传给 CLI 的参数。
 * @param {Array<{ mediaType?: string, data: Uint8Array | string }>} [options.attachments]
 *   图片附件；`data` 为 `Uint8Array` 或 base64 字符串。
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
export async function runCli({ cliPath, args, attachments = [], input, cwd, timeoutMs, idleTimeoutMs, signal, onStdout, collectStdout = true, env = process.env } = {}) {
  const prepared = materializeAttachments(attachments)
  try {
    return await spawnCli({
      cliPath,
      args: appendAttachmentArgs(args, prepared.paths),
      input,
      cwd,
      timeoutMs,
      idleTimeoutMs,
      signal,
      onStdout,
      collectStdout,
      env,
    })
  } finally {
    removeAttachmentDir(prepared.dir)
  }
}

/** spawn 并等待退出；附件临时目录由调用方 `runCli` 的 `finally` 删除。 */
function spawnCli({ cliPath, args, input, cwd, timeoutMs, idleTimeoutMs, signal, onStdout, collectStdout, env }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(cliPath, args, {
        cwd: cwd || undefined,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
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
      const taskkill = spawnProcess("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true })
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

/**
 * 把图片附件写成系统临时目录里的文件。
 *
 * 每次调用一个独立目录（`mkdtemp`），文件名按附件顺序编号，扩展名由 mediaType 决定，
 * 未知类型用 `.bin` 交给 CLI 按内容识别。
 *
 * @param {Array<{ mediaType?: string, data: Uint8Array | string }>} attachments
 * @returns {{ dir: string | undefined, paths: string[] }}
 */
function materializeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return { dir: undefined, paths: [] }
  const dir = mkdtempSync(join(tmpdir(), "qoder-attachments-"))
  try {
    const paths = attachments.map((attachment, index) => {
      const mediaType = String(attachment?.mediaType ?? "").trim().toLowerCase()
      const extension = ATTACHMENT_EXTENSIONS[mediaType] ?? ".bin"
      const path = join(dir, `attachment-${index}${extension}`)
      writeFileSync(path, attachmentBuffer(attachment?.data))
      return path
    })
    return { dir, paths }
  } catch (error) {
    removeAttachmentDir(dir)
    throw error
  }
}

function attachmentBuffer(data) {
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (typeof data === "string") return Buffer.from(data, "base64")
  throw new TypeError("Qoder image attachments must be a Uint8Array or a base64 string.")
}

/**
 * 把 `--attachment <path>` 追加进 CLI 参数。
 *
 * `--tools` 是变长参数且必须留在最后（见 `buildCliArgs`），附件插在它前面，
 * 否则附件路径会被 CLI 当成工具名。
 */
function appendAttachmentArgs(args, paths) {
  const finalArgs = Array.isArray(args) ? [...args] : []
  if (paths.length === 0) return finalArgs
  const flags = paths.flatMap((path) => ["--attachment", path])
  const toolsIndex = finalArgs.indexOf("--tools")
  if (toolsIndex >= 0) finalArgs.splice(toolsIndex, 0, ...flags)
  else finalArgs.push(...flags)
  return finalArgs
}

function removeAttachmentDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
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
