/**
 * 文件职责：OpenCode 服务端插件入口：注册 Qoder provider 与模型目录、`/qoder` 命令、`qoder` RPC。
 * 上游：OpenCode 插件加载器调用 QoderProviderPlugin.setup。
 * 下游：src/catalog、src/catalog-sync、src/command、src/logger、src/models、src/options、src/provider、src/quota、src/stats、rpc.ts、provider.mjs。
 */
import { Plugin } from "@opencode/plugin"
import type { Model } from "@opencode/schema/model"
import type { Provider } from "@opencode/schema/provider"
import { fileURLToPath, pathToFileURL } from "node:url"

import { fetchCliVersion, fetchModelList } from "./src/catalog.mjs"
import { createCatalogSync } from "./src/catalog-sync.mjs"
import { buildLoginText, buildModelsText, buildStatusText, buildUsageText, parseSubcommand, preview } from "./src/command.mjs"
import { readCallLog } from "./src/logger.mjs"
import { buildModelCatalog } from "./src/models.mjs"
import { PROVIDER_ID, PROVIDER_NAME, resolveOptions } from "./src/options.mjs"
import { createQoder } from "./src/provider.mjs"
import { createQuotaStore, formatQuotaStatus } from "./src/quota.mjs"
import { computeQoderStats } from "./src/stats.mjs"
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

export const QoderProviderPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const providerFile = fileURLToPath(new URL("./provider.mjs", import.meta.url))
    const providerPackage = `aisdk:${pathToFileURL(providerFile).href}`

    const options = resolveOptions({ ...(ctx.options ?? {}), cwd: ctx.location?.directory })
    const sdk = createQoder(options)
    const readUsage = (ctx.options as any)?.readUsage
    const quotaStore = createQuotaStore({
      cliPath: options.cliPath,
      cwd: options.cwd,
      readUsage: typeof readUsage === "function" ? readUsage : undefined,
    })

    let catalog: CatalogEntry[] = PLACEHOLDER_CATALOG
    let discoveryError: string | undefined
    let cliVersion: string | undefined
    let discoveryGeneration = 0

    // 目录状态按 location 隔离，但 refresh 的发现结果要同步给所有已加载 location：
    // 广播到达时同时递增代数，让更早发起的慢发现不能覆盖广播结果。
    const catalogSync = createCatalogSync({
      location: options.cwd ?? ctx.location?.directory,
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

    /**
     * `/qoder` 命令的唯一实现。
     *
     * 服务端命令与 `qoder` RPC 契约都调用它，保证 TUI dialog 与 API 的回答不会各写一套。
     */
    const executeQoderCommand = async (text: string): Promise<string> => {
      const subcommand = parseSubcommand(text)

      if (subcommand === "refresh") {
        const ok = await discover()
        // 发现成功才广播；失败保留旧目录且不打扰其他 location。
        // 各 location 的本地目录更新与 provider.reload() 都由订阅回调统一执行，含本实例。
        if (ok) await catalogSync.publish(catalog)
        const quota = await quotaStore.read({ refresh: true })
        const catalogText = ok
          ? `Refreshed the Qoder model catalog: ${catalog.length} models (${preview(catalog)}).`
          : `Could not refresh the Qoder model catalog: ${discoveryError}\nThe previous catalog (${preview(catalog)}) stays active.`
        return `${catalogText}\n${formatQuotaStatus(quota)}`
      }
      if (subcommand === "models") return buildModelsText(catalog, discoveryError)
      if (subcommand === "login") return buildLoginText(options.cliPath)
      if (subcommand === "status") {
        const quota = await quotaStore.read({ refresh: true })
        return `${buildStatusText(options, catalog, discoveryError, cliVersion)}\n${formatQuotaStatus(quota)}`
      }
      return buildUsageText()
    }

    // OpenCode 通过这个 hook 解析 `aisdk:` 包路径，随后调用 `sdk.languageModel(modelID)`。
    await ctx.aisdk.hook(
      "sdk",
      (input) => {
        input.sdk = sdk
      },
      { providerID: PROVIDER_ID },
    )

    await ctx.provider.transform((editor) => {
      editor.add({
        info: buildProviderInfo(providerPackage),
        models: buildModelInfos(catalog, providerPackage, options.contextLimit),
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "qoder",
        description: "Qoder provider status, model refresh, catalog and login help",
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
        const { text } = input as { text: string }
        return { text: await executeQoderCommand(text) }
      },
      stats: async () => {
        // 只读聚合本地调用日志：不调模型、不读取官方配额。
        const entries = readCallLog(options.logFile, 100_000)
        return computeQoderStats(entries, {
          provider: PROVIDER_ID,
          models: catalog.length,
          authenticated: discoveryError === undefined,
          permissionMode: options.permissionMode,
          cliVersion: cliVersion ?? "",
        })
      },
      quota: async (input) => quotaStore.read({
        refresh: (input as { refresh?: boolean }).refresh === true,
      }),
    })

    return async () => {
      catalogSync.dispose()
      quotaStore.dispose()
      await rpcRegistration.dispose()
    }
  },
})


function buildProviderInfo(providerPackage: string): Provider.Info {
  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    activation: "enabled",
    package: providerPackage,
  } as unknown as Provider.Info
}

function buildModelInfos(catalog: CatalogEntry[], providerPackage: string, contextLimit: number): Model.Info[] {
  return catalog.map((entry) => ({
    id: entry.id,
    modelID: entry.modelID,
    providerID: PROVIDER_ID,
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
