/**
 * 文件职责：`/qoder` 子命令与变体 token 的解析，以及 status/models/login/usage 文案的纯拼装。
 * 上游：index.ts 的 `/qoder` 命令与 RPC execute、tui.ts 的 parseCommand。
 * 下游：src/logger（读调用日志、累加 Credits）、src/variants（变体描述符）、src/pricing（倍率与促销态文案）。
 */
import { entryVariant, readCallLog, sumCredits } from "./logger.mjs"
import { DEFAULT_VARIANT_ID, getVariant, variantFromToken, variantModelReference } from "./variants.mjs"
import { modelPricingLine, pricingStatusLine } from "./pricing.mjs"

/**
 * 解析一次 `/qoder ...` 调用：变体 + 子命令。
 *
 * 变体 token 可写 `cn` / `qodercn`（CN 变体）或 `intl` / `qoder` / `global`（海外变体）；
 * 缺省是 CN（向后兼容旧行为）。token 放在子命令前后都认：
 * `/qoder intl models` 与 `/qoder models intl` 等价。
 *
 * `explicit` 表示文本里是否真的写了变体 token：写了就以文本为准，
 * 没写才允许调用方（RPC 入参）指定变体。
 *
 * 调用方：index.ts 的 executeQoderCommand、tui.ts 的 runQoderCommand。
 *
 * @param {string} text
 * @returns {{ variantId: string, subcommand: string, explicit: boolean }}
 */
export function parseCommand(text) {
  const tokens = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.replace(/^\/+/, "").toLowerCase())

  // 命令名本身（"/qoder"）不是变体 token。
  const rest = tokens[0] === "qoder" ? tokens.slice(1) : tokens

  let variantId = DEFAULT_VARIANT_ID
  let explicit = false
  let args = rest
  if (args.length > 0 && variantFromToken(args[0])) {
    variantId = variantFromToken(args[0])
    explicit = true
    args = args.slice(1)
  } else if (args.length > 1 && variantFromToken(args[args.length - 1])) {
    variantId = variantFromToken(args[args.length - 1])
    explicit = true
    args = args.slice(0, -1)
  }

  return { variantId, subcommand: args[0] ?? "status", explicit }
}

/**
 * 从一次 `/qoder ...` 调用里解析出子命令（不含变体 token）。
 *
 * 调用方：tui.ts 判断是否为 refresh。
 *
 * @param {string} text
 * @returns {string} 子命令；没有给参数时为 "status"
 */
export function parseSubcommand(text) {
  return parseCommand(text).subcommand
}

/**
 * 目录的简短预览，用于 status 与 refresh 文案。
 *
 * @param {Array<{ id: string }>} catalog
 * @param {number} [limit]
 * @param {string} [variantId]
 * @returns {string}
 */
export function preview(catalog, limit = 6, variantId = DEFAULT_VARIANT_ID) {
  const shown = catalog.slice(0, limit).map((entry) => variantModelReference(variantId, entry.id))
  if (catalog.length > limit) shown.push("…")
  return shown.join(", ")
}

/**
 * 拼出 `/qoder status` 文案。
 *
 * 只读本地调用日志：不跑模型，也不联网。
 *
 * @param {{ variantId?: string, cliPath: string, permissionMode: string, timeoutMs: number, idleTimeoutMs: number, logFile: string, cwd?: string }} options
 * @param {Array<{ id: string, modelID: string, name: string }>} catalog
 * @param {string|undefined} discoveryError
 * @param {string|undefined} cliVersion
 * @param {Record<string, any>|null|undefined} [pricing] 每模型倍率快照；缺失时省略 Pricing 行
 * @param {number} [nowMs] 倒计时基准时间
 * @returns {string}
 */
export function buildStatusText(options, catalog, discoveryError, cliVersion, pricing, nowMs = Date.now()) {
  const variant = getVariant(options.variantId ?? DEFAULT_VARIANT_ID)
  const lines = [`${variant.name} provider status (${variant.id})`]
  lines.push(`- CLI: ${options.cliPath}${cliVersion ? ` (${cliVersion})` : ""}`)
  lines.push(
    discoveryError
      ? `- Auth: unavailable — ${discoveryError}`
      : `- Auth: ok (${catalog.length} models discovered)`,
  )
  lines.push(`- Models: ${catalog.length} (${preview(catalog, 6, variant.id)})`)
  lines.push(`- Permission mode: ${options.permissionMode}`)
  lines.push(`- Total timeout: ${options.timeoutMs} ms`)
  lines.push(`- Idle timeout: ${options.idleTimeoutMs} ms (stdout/stderr activity resets it)`)
  lines.push(`- Working directory: ${options.cwd ?? "(inherited)"}`)
  lines.push(`- Log: ${options.logFile}`)

  const entries = readCallLog(options.logFile, 100_000).filter((entry) => entryVariant(entry) === variant.id)
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
 * @param {string} [variantId]
 * @returns {string}
 */
export function buildModelsText(catalog, discoveryError, pricing, nowMs = Date.now(), variantId = DEFAULT_VARIANT_ID) {
  const variant = getVariant(variantId)
  const lines = [`${variant.name} models (${catalog.length})`]
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
    lines.push(`- ${variantModelReference(variant.id, entry.id.padEnd(width))}  ${entry.name}${suffix}`)
  }
  return lines.join("\n")
}

/**
 * 拼出 `/qoder login` 文案。插件从不代跑交互式登录，只打印指引。
 *
 * @param {string} cliPath
 * @param {string} [variantId]
 * @returns {string}
 */
export function buildLoginText(cliPath, variantId = DEFAULT_VARIANT_ID) {
  const variant = getVariant(variantId)
  return [
    `Authenticate the ${variant.label} CLI (this plugin never runs the interactive login for you):`,
    "",
    "1. Open a terminal.",
    `2. Run: ${cliPath} login`,
    "3. Complete the login shown by the CLI.",
    "",
    `Afterwards run \`/qoder ${variant.commandTokens[0]} refresh\` to reload the model catalog and \`/qoder ${variant.commandTokens[0]} status\` to verify.`,
  ].join("\n")
}

/**
 * 未知子命令时显示的用法文案。
 *
 * @returns {string}
 */
export function buildUsageText() {
  return [
    "Usage: /qoder [variant] <command>",
    "",
    "Variants:",
    "- cn | qodercn   QoderCN (Credits), CLI qoderclicn (default)",
    "- intl | qoder  Qoder (Credits), overseas CLI qodercli",
    "",
    "Commands:",
    "- status   CLI path, authentication, model count, last call and credits (default)",
    "- refresh  re-discover the models and reload the provider",
    "- models   list the selectable model IDs of the variant",
    "- login    show how to authenticate the variant's CLI",
  ].join("\n")
}
