/**
 * 文件职责：OpenCode 服务端插件入口：注册两个 Qoder provider（CN / 海外）与其模型目录、`/qoder` 命令、`qoder` RPC。
 * 上游：OpenCode 插件加载器调用 QoderProviderPlugin.setup。
 * 下游：src/catalog、src/catalog-sync、src/command、src/logger、src/models、src/options、src/pricing、
 *       src/provider、src/quota、src/stats、src/variants、rpc.ts、provider.mjs。
 *
 * 两个变体各自独立：目录发现、额度读取、倍率快照、目录同步域、调用日志归属都按变体隔离；
 * provider 注册与 RPC 契约共用一份（契约只增 `variant` 字段）。
 */
import { Plugin } from "@opencode/plugin"
import type { Model } from "@opencode/schema/model"
import type { Provider } from "@opencode/schema/provider"
import { fileURLToPath, pathToFileURL } from "node:url"

import { fetchCliVersion, fetchModelList } from "./src/catalog.mjs"
import { createCatalogSync } from "./src/catalog-sync.mjs"
import { buildLoginText, buildModelsText, buildStatusText, buildUsageText, parseCommand, preview } from "./src/command.mjs"
import { readCallLog } from "./src/logger.mjs"
import { buildModelCatalog } from "./src/models.mjs"
import { resolveOptions } from "./src/options.mjs"
import { createPricingStore } from "./src/pricing.mjs"
import { fetchPricingFromQoder } from "./src/pricing-qoder.mjs"
import { createQoder } from "./src/provider.mjs"
import { createQuotaStore, formatQuotaStatus } from "./src/quota.mjs"
import { computeQoderStats } from "./src/stats.mjs"
import { DEFAULT_VARIANT_ID, VARIANT_IDS, getVariant, isVariantId } from "./src/variants.mjs"
import { QoderRpc } from "./rpc.ts"

const PLUGIN_ID = "opencode-qoder-provider"

/**
 * CLI 缺失或未登录时注册的占位目录：模型仍可选中，让用户拿到可执行的报错，
 * 而不是整个 provider 没有模型可选。
 */
const PLACEHOLDER_CATALOG = [
  { id: "auto", modelID: "Auto", name: "Auto" },
  { id: "fast", modelID: "Fast", name: "Fast" },
]

interface CatalogEntry {
  id: string
  modelID: string
  name: string
}

/**
 * 单个变体的运行时：自己的选项、SDK、额度与倍率存储、目录发现与同步域。
 */
interface VariantRuntime {
  id: string
  name: string
  options: ReturnType<typeof resolveOptions>
  sdk: ReturnType<typeof createQoder>
  quotaStore: ReturnType<typeof createQuotaStore>
  pricingStore: ReturnType<typeof createPricingStore>
  catalog: () => CatalogEntry[]
  discoveryError: () => string | undefined
  cliVersion: () => string | undefined
  discover: () => Promise<boolean>
  publishCatalog: () => Promise<unknown>
  stats: (entries: Array<Record<string, any>>) => ReturnType<typeof computeQoderStats>
  dispose: () => Promise<void>
}

export const QoderProviderPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const providerFile = fileURLToPath(new URL("./provider.mjs", import.meta.url))
    const providerPackage = `aisdk:${pathToFileURL(providerFile).href}`

    const rawOptions = { ...(ctx.options ?? {}), cwd: ctx.location?.directory }
    const runtimes = await Promise.all(VARIANT_IDS.map((variantId) => createVariantRuntime(variantId, ctx, rawOptions)))
    const runtimeFor = (variantId: string | undefined) =>
      runtimes.find((runtime) => runtime.id === variantId) ?? runtimes[0]!

    /**
     * `/qoder` 命令的唯一实现。
     *
     * 服务端命令与 `qoder` RPC 契约都调用它，保证 TUI dialog 与 API 的回答不会各写一套。
     * 文本里的变体 token 优先于 RPC 入参的 `variant`。
     */
    const executeQoderCommand = async (text: string, variantOverride?: string): Promise<string> => {
      const parsed = parseCommand(text)
      const variantId = parsed.explicit ? parsed.variantId : (isVariantId(variantOverride) ? variantOverride : parsed.variantId)
      const runtime = runtimeFor(variantId)
      const subcommand = parsed.subcommand

      if (subcommand === "refresh") {
        const ok = await runtime.discover()
        // 发现成功才广播；失败保留旧目录且不打扰其他 location。
        // 各 location 的本地目录更新与 provider.reload() 都由订阅回调统一执行，含本实例。
        if (ok) await runtime.publishCatalog()
        const [quota] = await Promise.all([
          runtime.quotaStore.read({ refresh: true }),
          runtime.pricingStore.read({ refresh: true }),
        ])
        const catalogText = ok
          ? `Refreshed the ${runtime.name} model catalog: ${runtime.catalog().length} models (${preview(runtime.catalog(), 6, runtime.id)}).`
          : `Could not refresh the ${runtime.name} model catalog: ${runtime.discoveryError()}\nThe previous catalog (${preview(runtime.catalog(), 6, runtime.id)}) stays active.`
        return `${catalogText}\n${formatQuotaStatus(quota)}`
      }
      if (subcommand === "models") {
        const pricing = await runtime.pricingStore.read()
        return buildModelsText(runtime.catalog(), runtime.discoveryError(), pricing, Date.now(), runtime.id)
      }
      if (subcommand === "login") return buildLoginText(runtime.options.cliPath, runtime.id)
      if (subcommand === "status") {
        const [quota, pricing] = await Promise.all([
          runtime.quotaStore.read({ refresh: true }),
          runtime.pricingStore.read(),
        ])
        return `${buildStatusText(runtime.options, runtime.catalog(), runtime.discoveryError(), runtime.cliVersion(), pricing, Date.now())}\n${formatQuotaStatus(quota)}`
      }
      return buildUsageText()
    }

    // 两个 provider 一次注册：OpenCode 的 transform 在 reload 时会整体重放。
    await ctx.provider.transform((editor) => {
      for (const runtime of runtimes) {
        editor.add({
          info: buildProviderInfo(providerPackage, runtime.id, runtime.name),
          models: buildModelInfos(runtime.catalog(), providerPackage, runtime.options.contextLimit, runtime.id),
        })
      }
    })

    // 每个变体一个 scoped aisdk hook：OpenCode 按 provider ID 把各自的 SDK 接上。
    for (const runtime of runtimes) {
      await ctx.aisdk.hook(
        "sdk",
        (input) => {
          input.sdk = runtime.sdk
        },
        { providerID: runtime.id },
      )
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "qoder",
        description: "Qoder provider status, model refresh, catalog and login help (CN and overseas variants)",
        execute: async (input) => {
          const text = await executeQoderCommand(input.prompt.text)

          // `resume: false` 让消息只留在 session inbox 而不唤醒会话：
          // 本地状态命令绝不能触发模型调用。
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text,
            delivery: input.delivery,
            resume: false,
          })
        },
      })
    })

    // TUI 侧调用这份契约把回答显示在 dialog 里，并为侧边栏 Credits 面板取数。
    const rpcRegistration = await ctx.rpc.register(QoderRpc, {
      execute: async (input) => {
        const { text, variant } = input as { text: string, variant?: string }
        return { text: await executeQoderCommand(text, variant) }
      },
      stats: async (input) => {
        const runtime = runtimeFor((input as { variant?: string }).variant)
        // 只读聚合本地调用日志：不调模型、不读取官方配额。
        const entries = readCallLog(runtime.options.logFile, 100_000)
        return runtime.stats(entries)
      },
      quota: async (input) => {
        const runtime = runtimeFor((input as { variant?: string }).variant)
        return runtime.quotaStore.read({
          refresh: (input as { refresh?: boolean }).refresh === true,
        })
      },
      pricing: async (input) => {
        const runtime = runtimeFor((input as { variant?: string }).variant)
        return runtime.pricingStore.read({
          refresh: (input as { refresh?: boolean }).refresh === true,
        })
      },
    })

    return async () => {
      for (const runtime of runtimes) await runtime.dispose()
      await rpcRegistration.dispose()
    }
  },
})

/**
 * 建立单个变体的运行时实例，并完成首次目录发现与版本读取。
 *
 * @param {string} variantId
 * @param {any} ctx OpenCode 插件上下文
 * @param {Record<string, any>} rawOptions 插件原始选项
 * @returns {Promise<VariantRuntime>}
 */
async function createVariantRuntime(variantId: string, ctx: any, rawOptions: Record<string, any>): Promise<VariantRuntime> {
  const variant = getVariant(variantId)
  const options = resolveOptions({ ...rawOptions, variant: variantId })
  const sdk = createQoder(options)

  const readUsage = rawOptions.variants?.[variantId]?.readUsage ?? rawOptions.readUsage
  const quotaStore = createQuotaStore({
    cliPath: options.cliPath,
    variantId: variant.id,
    cwd: options.cwd,
    readUsage: typeof readUsage === "function" ? readUsage : undefined,
  })

  // 默认真实提取器只跑 `--list-models`（零模型调用）；测试/后续接入仍可经 options.fetchPricing 注入覆盖。
  const injectedFetchPricing = rawOptions.variants?.[variantId]?.fetchPricing ?? rawOptions.fetchPricing
  const pricingStore = createPricingStore({
    ttlMs: options.pricingTtlMs,
    fetchPricing: typeof injectedFetchPricing === "function"
      ? injectedFetchPricing
      : () => fetchPricingFromQoder({
          cliPath: options.cliPath,
          cwd: options.cwd,
          timeoutMs: options.pricingTimeoutMs,
        }),
  })

  let catalog: CatalogEntry[] = PLACEHOLDER_CATALOG
  let discoveryError: string | undefined
  let cliVersion: string | undefined
  let discoveryGeneration = 0

  // 目录状态按 location 隔离，但 refresh 的发现结果要同步给所有已加载 location：
  // 广播到达时同时递增代数，让更早发起的慢发现不能覆盖广播结果。
  // 同步域按变体隔离：两个变体的目录互不覆盖。
  const catalogSync = createCatalogSync({
    location: options.cwd ?? ctx.location?.directory,
    scope: `qoder-provider.${variant.id}`,
    apply: async (entries: CatalogEntry[]) => {
      discoveryGeneration += 1
      catalog = entries
      discoveryError = undefined
      await ctx.provider.reload()
    },
  })

  const discover = async () => {
    const generation = ++discoveryGeneration
    try {
      const entries = await fetchModelList({
        cliPath: options.cliPath,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
      })
      const built = buildModelCatalog(entries)
      if (built.length === 0) throw new Error("Qoder CLI returned an empty model catalog.")
      if (generation !== discoveryGeneration) return false
      catalog = built
      discoveryError = undefined
      return true
    } catch (error) {
      if (generation === discoveryGeneration) {
        discoveryError = error instanceof Error ? error.message : String(error)
      }
      return false
    }
  }

  await discover()
  try {
    cliVersion = await fetchCliVersion({ cliPath: options.cliPath })
  } catch {
    cliVersion = undefined
  }

  return {
    id: variant.id,
    name: variant.name,
    options,
    sdk,
    quotaStore,
    pricingStore,
    catalog: () => catalog,
    discoveryError: () => discoveryError,
    cliVersion: () => cliVersion,
    discover,
    publishCatalog: () => catalogSync.publish(catalog),
    stats: (entries) => computeQoderStats(entries, {
      provider: variant.id,
      models: catalog.length,
      authenticated: discoveryError === undefined,
      permissionMode: options.permissionMode,
      cliVersion: cliVersion ?? "",
    }),
    dispose: async () => {
      catalogSync.dispose()
      quotaStore.dispose()
      pricingStore.dispose()
    },
  }
}

function buildProviderInfo(providerPackage: string, providerId: string, providerName: string): Provider.Info {
  return {
    id: providerId,
    name: providerName,
    activation: "enabled",
    package: providerPackage,
  } as unknown as Provider.Info
}

function buildModelInfos(catalog: CatalogEntry[], providerPackage: string, contextLimit: number, providerId: string): Model.Info[] {
  return catalog.map((entry) => ({
    id: entry.id,
    modelID: entry.modelID,
    providerID: providerId,
    name: entry.name,
    package: providerPackage,
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: contextLimit, output: 32_000 },
  })) as unknown as Model.Info[]
}

export default QoderProviderPlugin
