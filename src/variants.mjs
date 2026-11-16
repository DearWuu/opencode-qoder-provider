/**
 * 文件职责：Qoder 双变体描述符：provider ID、显示名、CLI 解析顺序、官方额度标签优先级与命令 token。
 * 上游：index.ts、src/options、src/command、src/provider、src/quota、panel.tsx、test/*。
 * 下游：node:fs、node:path（只读 PATH 与随包 CLI 路径）。
 *
 * 两个变体共用同一份插件代码，但各自独立：
 * - `qodercn`（QoderCN (Credits)）：CLI `qoderclicn`，登录态 `~/.qoder-cn`。
 * - `qoder`（Qoder (Credits)）：海外版 CLI，登录态 `~/.qoder`；只走 PATH（`qodercli` → `qoder`），不随包分发。
 */
import { existsSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** CN 变体：原 `qoder` provider 的迁移目标。 */
export const VARIANT_CN = "qodercn"

/** 海外变体：占用 `qoder` 这个 provider ID。 */
export const VARIANT_INTL = "qoder"

/** 全部变体 ID，顺序即面板与命令里的展示顺序。 */
export const VARIANT_IDS = [VARIANT_CN, VARIANT_INTL]

/** 未指定变体时的缺省变体（向后兼容旧行为：等同原 CN provider）。 */
export const DEFAULT_VARIANT_ID = VARIANT_CN

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * 变体描述符。
 *
 * `quotaLabels` 是官方 `/usage` 屏上额度标签的取值优先级：
 * 真实屏显示（2026-11-16 取证）
 * - CN（`qoderclicn`）：`OrgResourcePackage:9749/10000`，`PlanCreditsUsed:N/A`；
 * - 海外（`qodercli`）：`PlanCreditsUsed:4/570`，`OrgResourcePackage:0/5000`（未消耗的组织额度包）。
 * 同一屏出现多个数值额度时只按优先级取第一个，不做相加。
 */
export const VARIANTS = {
  [VARIANT_CN]: {
    id: VARIANT_CN,
    name: "QoderCN (Credits)",
    label: "QoderCN",
    cliNames: ["qoderclicn"],
    bundledCliPath: join("node_modules", "@qodercn-ai", "qoderclicn", "bundle", "qoderclicn.js"),
    cliPathEnv: "QODER_CN_CLI_PATH",
    legacyCliPathEnv: "QODER_CLI_PATH",
    quotaLabels: ["OrgResourcePackage", "PlanCreditsUsed", "Add-onCreditsUsed"],
    quotaSource: "QoderCN CLI /usage",
    commandTokens: ["cn", "qodercn"],
  },
  [VARIANT_INTL]: {
    id: VARIANT_INTL,
    name: "Qoder (Credits)",
    label: "Qoder",
    cliNames: ["qodercli", "qoder"],
    bundledCliPath: undefined,
    cliPathEnv: "QODER_INTL_CLI_PATH",
    legacyCliPathEnv: undefined,
    quotaLabels: ["PlanCreditsUsed", "OrgResourcePackage", "Add-onCreditsUsed"],
    quotaSource: "Qoder CLI /usage",
    commandTokens: ["intl", "qoder", "global"],
  },
}

/**
 * 取变体描述符。
 *
 * @param {string|undefined} id
 * @returns {typeof VARIANTS[string]}
 */
export function getVariant(id) {
  const variant = VARIANTS[String(id ?? "")]
  if (!variant) {
    throw new Error(`Unknown Qoder variant "${String(id)}". Allowed values: ${VARIANT_IDS.join(", ")}.`)
  }
  return variant
}

/**
 * 是否是已知变体 ID。
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isVariantId(id) {
  return typeof id === "string" && Object.hasOwn(VARIANTS, id)
}

/**
 * 把命令里的变体 token 解析成变体 ID；不是变体 token 时返回 undefined。
 *
 * @param {string|undefined} token
 * @returns {string|undefined}
 */
export function variantFromToken(token) {
  const text = String(token ?? "").trim().replace(/^\/+/, "").toLowerCase()
  if (!text) return undefined
  for (const variant of Object.values(VARIANTS)) {
    if (variant.commandTokens.includes(text)) return variant.id
  }
  return undefined
}

/**
 * 变体在命令里的首选 token（`cn` / `intl`）。
 *
 * @param {string} variantId
 * @returns {string}
 */
export function variantCommandToken(variantId) {
  return getVariant(variantId).commandTokens[0] ?? variantId
}

/**
 * 用户可见的模型引用：`{variantId}/{modelId}`。
 *
 * @param {string} variantId
 * @param {string} modelId
 * @returns {string}
 */
export function variantModelReference(variantId, modelId) {
  return `${variantId}/${modelId}`
}

/**
 * 随包 CLI 的绝对路径；不存在时返回 undefined。
 *
 * @param {string} variantId
 * @param {string} [packageRoot]
 * @returns {string|undefined}
 */
export function bundledCliPath(variantId, packageRoot = PACKAGE_ROOT) {
  const relative = getVariant(variantId).bundledCliPath
  if (!relative) return undefined
  const candidate = join(packageRoot, relative)
  return existsSync(candidate) ? candidate : undefined
}

/**
 * 在 PATH 上按顺序找可执行命令；找不到时返回第一个名字（让报错点名首选命令）。
 *
 * @param {string[]} names
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function pathCommand(names, env = process.env) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)
  const extensions = process.platform === "win32"
    ? String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""]
  for (const name of names) {
    for (const dir of dirs) {
      for (const extension of extensions) {
        const candidate = join(dir, `${name}${extension}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return names[0] ?? ""
}

/**
 * 解析某变体要 spawn 的 CLI 路径。
 *
 * 优先级：变体专属选项 → 变体专属环境变量 →（仅 CN）旧版全局 `cliPath`/`QODER_CLI_PATH`
 * →（仅 CN）随包 CLI → PATH 命令名。
 *
 * @param {string} variantId
 * @param {{ raw?: Record<string, any>, env?: Record<string, string | undefined>, packageRoot?: string }} [options]
 * @returns {string}
 */
export function resolveVariantCliPath(variantId, { raw = {}, env = process.env, packageRoot = PACKAGE_ROOT } = {}) {
  const variant = getVariant(variantId)
  const scoped = firstString(raw.variants?.[variant.id]?.cliPath)
  if (scoped) return scoped
  const scopedEnv = firstString(env[variant.cliPathEnv])
  if (scopedEnv) return scopedEnv

  if (variant.legacyCliPathEnv) {
    // 旧版只有 CN 一条链路：全局 cliPath 继续只作用于 CN 变体。
    const legacy = firstString(raw.cliPath) ?? firstString(env[variant.legacyCliPathEnv])
    if (legacy) return legacy
    const bundled = bundledCliPath(variant.id, packageRoot)
    if (bundled) return bundled
  }
  return pathCommand(variant.cliNames, env)
}

/**
 * CLI 的可读命令名：用于日志与错误文案（不含目录与扩展名）。
 *
 * @param {string} cliPath
 * @returns {string}
 */
export function cliCommandName(cliPath) {
  const text = String(cliPath ?? "").trim()
  if (!text) return ""
  const base = text.split(/[\\/]/).pop() ?? text
  return base.replace(/\.(?:js|mjs|cjs|cmd|exe)$/i, "")
}

function firstString(value) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
