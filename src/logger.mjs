/**
 * 文件职责：JSONL 调用日志的写入与读取（不含 prompt、回答或凭证）。
 * 上游：src/provider 记录每次调用、src/command 读最近调用、index.ts 的 stats 聚合。
 * 下游：node:fs、node:path。
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * 向 JSONL 日志追加一条调用记录。
 *
 * 日志永不包含 prompt、回答或任何凭证：只记模型、Credits 消耗与结果。
 *
 * 日志目录为私有（0700），日志文件从不对其他用户可读（0600），
 * 旧版本创建的文件也会被收紧。
 *
 * 调用方：src/provider 的 logCall。
 *
 * @param {string} file
 * @param {Record<string, any>} entry
 * @returns {void}
 */
export function appendCallLog(file, entry) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 })
    try {
      chmodSync(file, 0o600)
    } catch {
      // 尽力而为：文件属主不是当前用户时 chmod 可能失败。
    }
  } catch {
    // 日志写失败绝不能打断模型调用。
  }
}

/**
 * 为单次 Qoder 调用构建 JSONL 记录。
 *
 * @param {object} entry
 * @param {string} entry.requestedModel
 * @param {string} [entry.actualModel]
 * @param {string} [entry.usageModelKey]
 * @param {string[]} [entry.usageModelKeys]
 * @param {number} [entry.credits]
 * @param {number} [entry.durationMs]
 * @param {boolean} [entry.isError]
 * @param {number|null} [entry.exitCode]
 * @param {string} [entry.sessionId]
 * @param {boolean} [entry.timedOut]
 * @param {boolean} [entry.aborted]
 * @param {boolean} [entry.modelFallback]
 * @param {"idle"|"total"} [entry.timeoutKind]
 * @param {string} [entry.lastEventType]
 * @param {number} [entry.lastEventAgoMs]
 * @param {boolean} [entry.sawStdout]
 * @param {boolean} [entry.sawStderr]
 * @param {boolean} [entry.sawTextDelta]
 * @param {boolean} [entry.sawResult]
 * @returns {Record<string, any>}
 */
export function buildLogEntry({
  requestedModel, actualModel, usageModelKey, usageModelKeys, credits, durationMs, isError, exitCode,
  sessionId, timedOut, aborted, modelFallback, timeoutKind, lastEventType, lastEventAgoMs,
  sawStdout, sawStderr, sawTextDelta, sawResult,
}) {
  const entry = {
    ts: new Date().toISOString(),
    provider: "qoder",
    model: requestedModel,
    actualModel,
    modelFallback,
    usageModelKey,
    usageModelKeys,
    credits,
    durationMs,
    isError,
    exitCode,
    sessionId,
    timedOut,
    aborted,
    timeoutKind,
    lastEventType,
    lastEventAgoMs,
    sawStdout,
    sawStderr,
    sawTextDelta,
    sawResult,
  }
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key]
  }
  return entry
}

/**
 * 读取 JSONL 调用日志的最后若干条。
 * `/qoder status` 用它显示最近一次调用，无需模型往返。
 *
 * 调用方：index.ts 的 stats RPC、src/command 的 buildStatusText。
 *
 * @param {string} file
 * @param {number} [limit]
 * @returns {Array<Record<string, any>>}
 */
export function readCallLog(file, limit = 5) {
  if (!file) return []
  let content
  try {
    content = readFileSync(file, "utf8")
  } catch {
    return []
  }
  const entries = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // 跳过损坏的行，而不是让 status 命令失败。
    }
  }
  return entries.slice(-limit)
}

/**
 * 累加所有已记录调用的 Credits。
 *
 * 调用方：src/command 的 buildStatusText、src/stats 的 computeQoderStats。
 *
 * @param {Array<Record<string, any>>} entries
 * @returns {number}
 */
export function sumCredits(entries) {
  let total = 0
  for (const entry of entries) {
    if (typeof entry?.credits === "number" && Number.isFinite(entry.credits)) total += entry.credits
  }
  return total
}
