import { spawn } from "node:child_process"

/** Maximum number of stdout bytes kept from a CLI run. */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024
/** Maximum number of stderr bytes kept from a CLI run. */
export const MAX_STDERR_BYTES = 8 * 1024

/**
 * Build the Qoder CLI arguments for a single completion.
 *
 * `--input-format` is intentionally NOT passed: `qoderclicn` 1.1.85 rejects
 * `--input-format=stream-json` unless the output format is `stream-json` as
 * well ("--input-format=stream-json requires output-format=stream-json.").
 * The prompt is therefore written to stdin as plain text.
 *
 * `stream: true` switches to `-o stream-json --include-partial-messages`
 * (hidden flag, verified against the 1.1.85 bundle): the CLI then prints
 * line-delimited JSON events with real `text_delta` partials.
 *
 * `cliTools` semantics: `undefined` leaves the CLI default tools active,
 * `""` or `[]` disables every built-in tool (`--tools ""`), a non-empty
 * array is an allowlist. `maxOutputTokens` is forwarded only when it is a
 * positive integer; any other value is ignored (no flag) so a malformed
 * caller value never breaks the call.
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
  // `--tools` is variadic in the CLI and must stay last: it consumes every
  // following bare argument as a tool name.
  if (Array.isArray(cliTools)) {
    // A non-empty array is an allowlist; an empty array disables every
    // built-in tool, exactly like "".
    args.push("--tools", ...(cliTools.length > 0 ? cliTools : [""]))
  } else if (cliTools === "") {
    args.push("--tools", "")
  }
  return args
}

/**
 * Spawn the Qoder CLI and collect its output.
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] Executable to spawn.
 * @param {string[]} [options.args] Arguments passed to the CLI.
 * @param {string} [options.input] Text written to stdin.
 * @param {string} [options.cwd] Working directory of the CLI process.
 * @param {number} [options.timeoutMs] Kill the process tree after this many ms.
 * @param {AbortSignal} [options.signal] Aborts the run and kills the process tree.
 * @param {(chunk: Buffer) => void} [options.onStdout] Called for every raw stdout chunk, before the byte cap applies.
 * @param {boolean} [options.collectStdout=true] Keep a raw stdout copy. When false the 32 MiB capture
 *   buffer is neither allocated nor decoded; `stdout` resolves to "" and only the
 *   truncation flag keeps watching the byte count (onStdout still fires).
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, durationMs: number, timedOut: boolean, aborted: boolean, stdoutTruncated: boolean, stderrTruncated: boolean }>}
 */
export function runCli({ cliPath, args, input, cwd, timeoutMs, signal, onStdout, collectStdout = true, env = process.env } = {}) {
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

    // Fixed-capacity buffers bound retained memory even when one chunk exceeds a limit.
    const stdoutBuffer = collectStdout ? Buffer.allocUnsafe(MAX_STDOUT_BYTES) : undefined
    const stderrBuffer = Buffer.allocUnsafe(MAX_STDERR_BYTES)
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const timer = timeoutMs && timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs) : undefined

    const onAbort = () => {
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
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
    }

    child.stdout.on("data", (chunk) => {
      if (onStdout) {
        try {
          onStdout(chunk)
        } catch {
          // A broken stream consumer must not crash the raw capture.
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
        timedOut,
        aborted,
        stdoutTruncated,
        stderrTruncated,
      })
    })

    if (child.stdin) {
      child.stdin.on("error", () => {
        // The CLI may exit before the prompt is fully written; the close handler reports the real failure.
      })
      if (input !== undefined && input !== null) {
        child.stdin.write(input)
      }
      child.stdin.end()
    }
  })
}

/**
 * Extract the JSON result document from the CLI stdout.
 * The CLI prints exactly one JSON object, but it may be preceded by warnings.
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

/** Kill the CLI and every process it spawned. */
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
