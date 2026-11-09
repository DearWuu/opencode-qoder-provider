import { MAX_STDOUT_BYTES, runCli } from "./cli.mjs"
import { parseModelList } from "./models.mjs"

/**
 * Discover the models of the currently logged in Qoder account.
 *
 * `qoderclicn --list-models` prints a `MODEL` header followed by one line per
 * model and exits with code 1 when the CLI is not authenticated.
 *
 * @param {{ cliPath?: string, cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<Array<{ name: string, modelID: string }>>}
 */
export async function fetchModelList({ cliPath, cwd, timeoutMs } = {}) {
  const discoveryTimeoutMs = Math.min(timeoutMs ?? 60_000, 60_000)
  const run = await runCli({
    cliPath,
    args: ["--list-models"],
    cwd,
    timeoutMs: discoveryTimeoutMs,
  })

  if (run.timedOut) {
    throw new Error(`qoderclicn --list-models timed out after ${discoveryTimeoutMs} ms.`)
  }
  if (run.stdoutTruncated) {
    throw new Error(`qoderclicn --list-models stdout exceeded the ${MAX_STDOUT_BYTES} byte limit and was truncated.`)
  }
  if (run.code !== 0) {
    const details = run.stderr.trim().length > 0 ? run.stderr.trim().slice(0, 500) : `exit code ${run.code}`
    const error = new Error(`qoderclicn --list-models failed: ${details}`)
    error.exitCode = run.code
    throw error
  }

  return parseModelList(run.stdout)
}

/**
 * Read the CLI version (`qoderclicn --version`).
 *
 * @param {{ cliPath?: string, timeoutMs?: number }} [options]
 * @returns {Promise<string|undefined>}
 */
export async function fetchCliVersion({ cliPath, timeoutMs } = {}) {
  const run = await runCli({
    cliPath,
    args: ["--version"],
    timeoutMs: timeoutMs ?? 30_000,
  })
  const text = `${run.stdout}${run.stderr}`.trim()
  return text.length > 0 ? text.slice(0, 100) : undefined
}
