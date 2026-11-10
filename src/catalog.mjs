/**
 * 文件职责：经 CLI 发现模型目录（`--list-models`）与读取 CLI 版本（`--version`）。
 * 上游：index.ts 的 discover/cliVersion、scripts/check-real-catalog.mjs。
 * 下游：src/cli.runCli、src/models.parseModelList。
 */
import { MAX_STDOUT_BYTES, runCli } from "./cli.mjs"
import { parseModelList } from "./models.mjs"

/**
 * 发现当前已登录 Qoder 账号的模型。
 *
 * `qoderclicn --list-models` 先打印 `MODEL` 表头，再每行一个模型；未认证时退出码为 1。
 *
 * 调用方：index.ts 的 discover、scripts/check-real-catalog.mjs。
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
 * 读取 CLI 版本（`qoderclicn --version`）。
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
