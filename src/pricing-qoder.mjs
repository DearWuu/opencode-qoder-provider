/**
 * 文件职责：经 `qoderclicn --list-models` + 捕获 hook 提取每模型实时积分倍率快照（零模型调用）。
 * 上游：index.ts 的默认 fetchPricing（传 cliPath/cwd/超时）。
 * 下游：src/cli.runCli（spawn/超时/进程树终止）、src/pricing-capture.mjs（经 NODE_OPTIONS --import 注入 CLI）。
 *
 * CLI 的 `--list-models` 会先解密模型目录再打印；捕获 hook 包装 JSON.parse 取得同一份明文，
 * 因此不额外请求账户接口、不运行模型。任何失败（未登录、超时、形状不符、未捕获）都返回 null，
 * 不抛错、不编造数据，由面板隐藏倍率段并保留上一份成功快照。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { runCli } from "./cli.mjs"
import { PRICING_TIMEOUT_MS } from "./pricing.mjs"

/** 快照的 source 文案：说明数据来自目录明文的捕获，而不是账户 HTTP API。 */
export const PRICING_SOURCE = "qoderclicn --list-models + JSON.parse capture hook (catalog plaintext)"

const CAPTURE_DIR_ENV = "QODER_PRICING_CAPTURE_DIR"
const CAPTURE_HOOK_PATH = fileURLToPath(new URL("./pricing-capture.mjs", import.meta.url))
const CAPTURE_FILE = /^capture-(\d+)\.json$/

/**
 * 把捕获 hook 追加到既有 NODE_OPTIONS；绝不上整体覆盖，避免丢掉用户/环境已有的 Node 参数。
 *
 * @param {string|undefined} existing
 * @param {string} [hookUrl]
 * @returns {string}
 */
export function buildNodeOptions(existing, hookUrl = pathToFileURL(CAPTURE_HOOK_PATH).href) {
  const base = typeof existing === "string" ? existing.trim() : ""
  const injection = `--import=${hookUrl}`
  return base.length > 0 ? `${base} ${injection}` : injection
}

/**
 * 插件默认的倍率抓取器：调用 CLI 提取；任何失败返回 null。
 *
 * @param {{ cliPath?: string, cwd?: string, timeoutMs?: number, env?: Record<string, string|undefined>, now?: () => number }} [options]
 * @returns {Promise<object|null>}
 */
export async function fetchPricingFromQoder(options = {}) {
  return extractPricing(options)
}

/**
 * spawn `--list-models`，从捕获目录读取明文模型目录并映射为定价快照。
 *
 * @param {{ cliPath?: string, cwd?: string, timeoutMs?: number, env?: Record<string, string|undefined>, now?: () => number }} [options]
 * @returns {Promise<object|null>}
 */
export async function extractPricing(options = {}) {
  const {
    cliPath = "qoderclicn",
    cwd,
    timeoutMs = PRICING_TIMEOUT_MS,
    env = process.env,
    now = Date.now,
  } = options

  const captureDir = mkdtempSync(join(tmpdir(), "qoder-pricing-"))
  try {
    let run
    try {
      run = await runCli({
        cliPath,
        args: ["--list-models"],
        cwd,
        timeoutMs,
        env: {
          ...env,
          [CAPTURE_DIR_ENV]: captureDir,
          NODE_OPTIONS: buildNodeOptions(env.NODE_OPTIONS),
        },
        collectStdout: false,
      })
    } catch {
      return null
    }
    if (run.timedOut || run.code !== 0) return null
    return parsePricingCaptures(readCaptures(captureDir), new Date(now()).toISOString())
  } finally {
    try {
      rmSync(captureDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结果；目录位于系统临时目录。
    }
  }
}

/**
 * 把捕获到的明文目录映射为契约快照；没有可识别形状时返回 null。
 *
 * 只接受两种形状：顶层数组、或 `{ assistant: [...] }`，且每个元素都含非空 `display_name`
 * 与有限数值 `price_factor`。任一元素不符视作整体不可信，返回 null 而不是跳过。
 *
 * @param {unknown[]} captures 每个捕获文件解析后的对象。
 * @param {string} [fetchedAt]
 * @returns {object|null}
 */
export function parsePricingCaptures(captures, fetchedAt = new Date().toISOString()) {
  if (!Array.isArray(captures) || captures.length === 0) return null
  const models = findCatalog(captures)
  if (!models) return null

  const mapped = []
  for (const model of models) {
    if (!isPricingModel(model)) return null
    const entry = {
      modelKey: model.display_name.trim(),
      priceFactor: model.price_factor,
    }
    if (typeof model.key === "string" && model.key.trim().length > 0) entry.qoderKey = model.key.trim()
    if (typeof model.original_price_factor === "number" && Number.isFinite(model.original_price_factor)) {
      entry.originalPriceFactor = model.original_price_factor
    }
    const promotion = mapPromotion(model.promotion)
    if (promotion) entry.promotion = promotion
    mapped.push(entry)
  }
  if (mapped.length === 0) return null
  return { models: mapped, fetchedAt, source: PRICING_SOURCE }
}

/** 依次尝试顶层数组与 `{ assistant: [...] }`；未命中返回 undefined。 */
function findCatalog(captures) {
  for (const capture of captures) {
    if (Array.isArray(capture) && capture.length > 0 && capture.every(isPricingModel)) return capture
  }
  for (const capture of captures) {
    if (capture && typeof capture === "object" && !Array.isArray(capture)) {
      const assistant = capture.assistant
      if (Array.isArray(assistant) && assistant.length > 0 && assistant.every(isPricingModel)) return assistant
    }
  }
  return undefined
}

function isPricingModel(model) {
  return Boolean(model)
    && typeof model === "object"
    && !Array.isArray(model)
    && typeof model.display_name === "string"
    && model.display_name.trim().length > 0
    && typeof model.price_factor === "number"
    && Number.isFinite(model.price_factor)
}

function mapPromotion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const promotion = { active: value.active === true }
  assignNumber(promotion, "discountFactor", value.discount_factor)
  assignNumber(promotion, "beforePromotionPriceFactor", value.before_promotion_price_factor)
  assignString(promotion, "windowStart", value.window_start)
  assignString(promotion, "windowEnd", value.window_end)
  assignString(promotion, "timezone", value.timezone)
  const badge = pickText(value.badge)
  if (badge) promotion.badge = badge
  const description = pickText(value.description)
  if (description) promotion.description = description
  return promotion
}

function assignNumber(target, key, value) {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value
}

function assignString(target, key, value) {
  if (typeof value === "string" && value.length > 0) target[key] = value
}

/** 徽标/描述可能是 `{ zh, en }` 或纯字符串；优先中文。 */
function pickText(value) {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.zh === "string" && value.zh.length > 0) return value.zh
    if (typeof value.en === "string" && value.en.length > 0) return value.en
  }
  return undefined
}

/** 按文件序号读取捕获；坏文件直接跳过。 */
function readCaptures(directory) {
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const files = names
    .map((name) => ({ name, match: CAPTURE_FILE.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
  const captures = []
  for (const { name } of files) {
    try {
      captures.push(JSON.parse(readFileSync(join(directory, name), "utf8")))
    } catch {
      // 单个捕获损坏不影响其他捕获。
    }
  }
  return captures
}
