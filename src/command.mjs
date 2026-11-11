/**
 * 文件职责：`/qoder` 子命令解析，以及 status/models/login/usage 文案的纯拼装。
 * 上游：index.ts 的 `/qoder` 命令与 RPC execute、tui.ts 的 parseSubcommand。
 * 下游：src/logger（读调用日志、累加 Credits）、src/options（provider 名称）、src/pricing（倍率与促销态文案）。
 */
import { readCallLog, sumCredits } from "./logger.mjs"
import { PROVIDER_ID, PROVIDER_NAME } from "./options.mjs"
import { modelPricingLine, pricingStatusLine } from "./pricing.mjs"

/**
 * 从一次 `/qoder ...` 调用里解析出子命令。
 *
 * 同时接受原始 prompt 文本（"/qoder refresh"）和裸子命令（"refresh"），
 * 让 TUI 与服务端命令共用同一个解析器。
 *
 * 调用方：index.ts 的 executeQoderCommand、tui.ts 的 runQoderCommand。
 *
 * @param {string} text
 * @returns {string} 子命令；没有给参数时为 "status"
 */
export function parseSubcommand(text) {
  const parts = (text ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "status"
  const first = (parts[0] ?? "").replace(/^\/+/, "").toLowerCase()
  if (first !== "qoder") return first
  const second = (parts[1] ?? "").replace(/^\/+/, "").toLowerCase()
  return second.length > 0 ? second : "status"
}

/**
 * 目录的简短预览，用于 status 与 refresh 文案。
 *
 * @param {Array<{ id: string }>} catalog
 * @param {number} [limit]
 * @returns {string}
 */
export function preview(catalog, limit = 6) {
  const shown = catalog.slice(0, limit).map((entry) => `${PROVIDER_ID}/${entry.id}`)
  if (catalog.length > limit) shown.push("…")
  return shown.join(", ")
}

/**
 * 拼出 `/qoder status` 文案。
 *
 * 只读本地调用日志：不跑模型，也不联网。
 *
 * @param {{ cliPath: string, permissionMode: string, timeoutMs: number, idleTimeoutMs: number, logFile: string, cwd?: string }} options
 * @param {Array<{ id: string, modelID: string, name: string }>} catalog
 * @param {string|undefined} discoveryError
 * @param {string|undefined} cliVersion
 * @param {Record<string, any>|null|undefined} [pricing] 每模型倍率快照；缺失时省略 Pricing 行
 * @param {number} [nowMs] 倒计时基准时间
 * @returns {string}
 */
export function buildStatusText(options, catalog, discoveryError, cliVersion, pricing, nowMs = Date.now()) {
  const lines = [`Qoder provider status (${PROVIDER_ID} / ${PROVIDER_NAME})`]
  lines.push(`- CLI: ${options.cliPath}${cliVersion ? ` (${cliVersion})` : ""}`)
  lines.push(
    discoveryError
      ? `- Auth: unavailable — ${discoveryError}`
      : `- Auth: ok (${catalog.length} models discovered)`,
  )
  lines.push(`- Models: ${catalog.length} (${preview(catalog)})`)
  lines.push(`- Permission mode: ${options.permissionMode}`)
  lines.push(`- Total timeout: ${options.timeoutMs} ms`)
  lines.push(`- Idle timeout: ${options.idleTimeoutMs} ms (stdout/stderr activity resets it)`)
  lines.push(`- Working directory: ${options.cwd ?? "(inherited)"}`)
  lines.push(`- Log: ${options.logFile}`)

  const entries = readCallLog(options.logFile, 100_000)
  if (entries.length > 0) {
    const last = entries[entries.length - 1]
    lines.push(
      `- Last call: ${last.ts} model=${last.model ?? "?"} actual=${last.actualModel ?? "?"} ` +
        `credits=${last.credits ?? "?"} duration=${last.durationMs ?? "?"}ms error=${last.isError === true}`,
    )
    lines.push(`- Credits (${entries.length} logged calls): ${sumCredits(entries).toFixed(6)}`)
  } else {
    lines.push("- Last call: none yet")
  }
  const pricingLine = pricingStatusLine(pricing, nowMs)
  if (pricingLine) lines.push(pricingLine)
  return lines.join("\n")
}

/**
 * 拼出 `/qoder models` 文案。
 *
 * 有倍率快照时，在每个模型行尾追加「当前倍率 + 促销态」；缺失快照时保持原样。
 *
 * @param {Array<{ id: string, modelID: string, name: string }>} catalog
 * @param {string|undefined} discoveryError
 * @param {Record<string, any>|null|undefined} [pricing] 每模型倍率快照
 * @param {number} [nowMs] 倒计时基准时间
 * @returns {string}
 */
export function buildModelsText(catalog, discoveryError, pricing, nowMs = Date.now()) {
  const lines = [`Qoder models (${catalog.length})`]
  if (discoveryError) {
    lines.push(`Discovery failed: ${discoveryError}`)
    lines.push("Showing the placeholder catalog; run `/qoder login` and `/qoder refresh` after authenticating.")
  }
  const byModelKey = new Map()
  for (const model of Array.isArray(pricing?.models) ? pricing.models : []) {
    if (typeof model?.modelKey === "string") byModelKey.set(model.modelKey, model)
  }
  const width = catalog.reduce((max, entry) => Math.max(max, entry.id.length), 0)
  for (const entry of catalog) {
    const pricingText = modelPricingLine(byModelKey.get(entry.modelID), nowMs)
    const suffix = pricingText ? `  ${pricingText}` : ""
    lines.push(`- ${PROVIDER_ID}/${entry.id.padEnd(width)}  ${entry.name}${suffix}`)
  }
  return lines.join("\n")
}

/**
 * 拼出 `/qoder login` 文案。插件从不代跑交互式登录，只打印指引。
 *
 * @param {string} cliPath
 * @returns {string}
 */
export function buildLoginText(cliPath) {
  return [
    "Authenticate the Qoder CLI (this plugin never runs the interactive login for you):",
    "",
    "1. Open a terminal.",
    `2. Run: ${cliPath} login`,
    "3. Complete the login shown by the CLI.",
    "",
    "Afterwards run `/qoder refresh` to reload the model catalog and `/qoder status` to verify.",
  ].join("\n")
}

/**
 * 未知子命令时显示的用法文案。
 *
 * @returns {string}
 */
export function buildUsageText() {
  return [
    "Usage: /qoder <command>",
    "",
    "- status   CLI path, authentication, model count, last call and credits (default)",
    "- refresh  re-discover the models and reload the provider",
    "- models   list the selectable qoder/* model IDs",
    "- login    show how to authenticate the Qoder CLI",
  ].join("\n")
}
