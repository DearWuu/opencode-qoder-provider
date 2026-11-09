import { Plugin } from "@opencode/plugin"
import type { Model } from "@opencode/schema/model"
import type { Provider } from "@opencode/schema/provider"
import { fileURLToPath, pathToFileURL } from "node:url"

import { fetchCliVersion, fetchModelList } from "./src/catalog.mjs"
import { buildLoginText, buildModelsText, buildStatusText, buildUsageText, parseSubcommand, preview } from "./src/command.mjs"
import { buildModelCatalog } from "./src/models.mjs"
import { PROVIDER_ID, PROVIDER_NAME, resolveOptions } from "./src/options.mjs"
import { createQoder } from "./src/provider.mjs"
import { QoderRpc } from "./rpc.ts"

const PLUGIN_ID = "opencode-qoder-provider"

/**
 * Catalog that is registered when the Qoder CLI is missing or not logged in.
 * The models stay selectable so the user gets an actionable error instead of a
 * missing model.
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

    let catalog: CatalogEntry[] = PLACEHOLDER_CATALOG
    let discoveryError: string | undefined
    let cliVersion: string | undefined
    let discoveryGeneration = 0

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
     * Single implementation of the `/qoder` command.
     *
     * The server command and the `qoder` RPC contract both call it, so the
     * TUI dialog and the API answer can never drift apart.
     */
    const executeQoderCommand = async (text: string): Promise<string> => {
      const subcommand = parseSubcommand(text)

      if (subcommand === "refresh") {
        const ok = await discover()
        await ctx.provider.reload()
        return ok
          ? `Refreshed the Qoder model catalog: ${catalog.length} models (${preview(catalog)}).`
          : `Could not refresh the Qoder model catalog: ${discoveryError}\nThe previous catalog (${preview(catalog)}) stays active.`
      }
      if (subcommand === "models") return buildModelsText(catalog, discoveryError)
      if (subcommand === "login") return buildLoginText(options.cliPath)
      if (subcommand === "status") return buildStatusText(options, catalog, discoveryError, cliVersion)
      return buildUsageText()
    }

    // OpenCode resolves the `aisdk:` package through this hook and then calls
    // `sdk.languageModel(modelID)`.
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

          // `resume: false` keeps the message in the session inbox without waking
          // the session: a local status command must never start a model call.
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text,
            delivery: input.delivery,
            resume: false,
          })
        },
      })
    })

    // The TUI part calls this contract to show the answer in a dialog.
    const rpcRegistration = await ctx.rpc.register(QoderRpc, {
      execute: async (input) => {
        const { text } = input as { text: string }
        return { text: await executeQoderCommand(text) }
      },
    })

    return async () => {
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
