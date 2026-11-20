/**
 * 文件职责：经 CLI `--list-models` + 捕获 hook 提取每模型实时积分倍率快照（零模型调用）。
 * 上游：index.ts 的默认 fetchPricing（传 cliPath/cwd/超时）。
 * 下游：src/cli.runCli（spawn/超时/进程树终止）、src/pricing-capture.mjs（经 NODE_OPTIONS --import 注入 CLI）、
 *       src/variants.cliCommandName（来源文案里的实际命令名）。
 *
 * CLI 的 `--list-models` 会先解密模型目录再打印；捕获 hook 包装 JSON.parse 取得同一份明文，
 * 因此不额外请求账户接口、不运行模型。任何失败（未登录、超时、形状不符、未捕获）都返回 null，
 * 不抛错、不编造数据，由面板隐藏倍率段并保留上一份成功快照。
 *
 * 首次提取可能赶在 CLI 冷启动（自举、令牌刷新）中间而拿不到目录，因此在提取层做有界重试：
 * 最多 3 次尝试、间隔 1.5 秒、整条链路总时长不超过 60 秒；重试仍失败才诚实降级为 null。
 * 重试放在提取层（而不是快照缓存层），注入的 fetchPricing 与单测 fake 不会被额外等待。
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { runCli } from "./cli.mjs"
import { PRICING_TIMEOUT_MS } from "./pricing.mjs"
import { cliCommandName } from "./variants.mjs"

/** 快照的 source 文案（CN 变体默认值）：说明数据来自目录明文的捕获，而不是账户 HTTP API。 */
export const PRICING_SOURCE = "qoderclicn --list-models + JSON.parse capture hook (catalog plaintext)"

/** 一次提取最多尝试的次数（含首次）：首次 + 2 次重试。 */
export const PRICING_MAX_ATTEMPTS = 3
/** 两次尝试之间的等待：1.5 秒，留给 CLI 冷启动自举与令牌刷新。 */
export const PRICING_RETRY_DELAY_MS = 1_500
/** 一条提取链路的尝试总时长预算：超出后不再重试，直接降级。 */
export const PRICING_RETRY_BUDGET_MS = 60_000

const CAPTURE_DIR_ENV = "QODER_PRICING_CAPTURE_DIR"
const CAPTURE_HOOK_PATH = fileURLToPath(new URL("./pricing-capture.mjs", import.meta.url))
const CAPTURE_FILE = /^capture-(\d+)\.json$/

/**
 * 按实际 CLI 命令名拼出来源文案（`qoderclicn` / `qodercli` 等）。
 *
 * @param {string} cliPath
 * @returns {string}
 */
export function pricingSourceLabel(cliPath) {
  const command = cliCommandName(cliPath)
  return command.length > 0
    ? `${command} --list-models + JSON.parse capture hook (catalog plaintext)`
    : PRICING_SOURCE
}

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
 * 插件默认的倍率抓取器：调用 CLI 提取；冷启动首拍拿不到目录时在预算内补试。
 *
 * @param {{ cliPath?: string, cwd?: string, timeoutMs?: number, env?: Record<string, string|undefined>, now?: () => number, maxAttempts?: number, retryDelayMs?: number, retryBudgetMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<object|null>}
 */
export async function fetchPricingFromQoder(options = {}) {
  return withColdStartRetry(() => extractPricing(options), options)
}

/**
 * 在总时长预算内重试一次提取；任何一次拿到快照即返回。
 *
 * 失败时一律返回 null：不构造快照、不补 fetchedAt、不编造倍率，由调用方保留上一份成功快照，
 * 或在没有旧快照时隐藏倍率段。首次成功后立即返回，不会为了「更稳」额外 spawn 一次 CLI。
 *
 * 调用方：fetchPricingFromQoder（index.ts 把这些选项从插件配置透传到该提取器）。
 *
 * @param {() => Promise<object|null>} attempt 单次提取。
 * @param {{ maxAttempts?: number, retryDelayMs?: number, retryBudgetMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<object|null>}
 */
export async function withColdStartRetry(attempt, options = {}) {
  const {
    maxAttempts = PRICING_MAX_ATTEMPTS,
    retryDelayMs = PRICING_RETRY_DELAY_MS,
    retryBudgetMs = PRICING_RETRY_BUDGET_MS,
    now = Date.now,
    sleep = defaultSleep,
  } = options
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 1
  const startedAt = now()
  for (let index = 1; index <= attempts; index += 1) {
    const snapshot = await attempt()
    if (snapshot) return snapshot
    if (index >= attempts) break
    // 剩余预算放不下下一次等待就放弃，避免一条读取链路拖过预算。
    if (now() - startedAt + retryDelayMs >= retryBudgetMs) break
    await sleep(retryDelayMs)
  }
  return null
}

/**
 * spawn `--list-models`，从捕获目录读取明文模型目录并映射为定价快照。
 *
 * 这是单次尝试：不含重试与等待，重试由 fetchPricingFromQoder 的 withColdStartRetry 负责，
 * 因此单测可以直接验证首次失败/成功的行为而不被额外延迟影响。
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
    return parsePricingCaptures(readCaptures(captureDir), new Date(now()).toISOString(), pricingSourceLabel(cliPath))
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
 * @param {string} [source] 来源文案（默认按 CN CLI 名）。
 * @returns {object|null}
 */
export function parsePricingCaptures(captures, fetchedAt = new Date().toISOString(), source = PRICING_SOURCE) {
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
  return { models: mapped, fetchedAt, source }
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

/** 默认等待实现；测试注入同步 resolve 的 sleep 以免真的等 1.5 秒。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
