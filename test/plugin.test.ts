import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { QoderProviderPlugin } from "../index.ts"

const FAKE_CN_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))
const FAKE_INTL_CLI = fileURLToPath(new URL("./fixtures/fake-qoder-intl.mjs", import.meta.url))
const OFFICIAL_USAGE = readFileSync(fileURLToPath(new URL("./fixtures/official-usage.txt", import.meta.url)), "utf8")
const PRICING_SNAPSHOT = {
  models: [
    {
      modelKey: "Qwen3.8-Max",
      priceFactor: 0.4,
      originalPriceFactor: 0.8,
      promotion: {
        active: true,
        beforePromotionPriceFactor: 0.8,
        windowStart: "22:00",
        windowEnd: "08:00",
        timezone: "Asia/Shanghai",
        badge: "错峰 4 折",
      },
    },
    { modelKey: "Auto", priceFactor: 1 },
  ],
  fetchedAt: "2026-11-11T10:00:00.000Z",
  source: "fixture",
}
const INTL_PRICING_SNAPSHOT = {
  models: [
    {
      modelKey: "Ultimate",
      priceFactor: 2,
      promotion: {
        active: false,
        discountFactor: 0.2,
        beforePromotionPriceFactor: 2,
        windowStart: "22:00",
        windowEnd: "08:00",
        timezone: "Asia/Singapore",
        badge: "错峰2折",
      },
    },
    { modelKey: "Auto", priceFactor: 0.5 },
  ],
  fetchedAt: "2026-11-16T10:00:00.000Z",
  source: "fixture-intl",
}

interface Harness {
  ctx: any
  providerAdds: any[]
  commands: any[]
  sdkHooks: Array<{ callback: (input: any) => void; options: any }>
  synthetic: any[]
  rpcDefinitions: any[]
  rpcHandlers: any[]
  rpcDisposed: { disposed: number }
  quotaReads: any[]
  pricingFetches: { cn: number; intl: number }
  reloads: { count: number }
}

function createHarness(options: { directory?: string; pricing?: any; intlPricing?: any } = {}): Harness {
  const dir = options.directory ?? mkdtempSync(join(tmpdir(), "qoder-plugin-test-"))
  const providerAdds: any[] = []
  const commands: any[] = []
  const sdkHooks: Array<{ callback: (input: any) => void; options: any }> = []
  const synthetic: any[] = []
  const rpcDefinitions: any[] = []
  const rpcHandlers: any[] = []
  const rpcState = { disposed: 0 }
  const quotaReads: any[] = []
  const pricingFetches = { cn: 0, intl: 0 }
  const reloads = { count: 0 }
  let transformCallback: ((editor: any) => void) | undefined
  const editor = {
    list: () => [],
    get: () => undefined,
    add: (input: any) => providerAdds.push(input),
    update: () => {},
    remove: () => {},
    models: { set: () => {}, update: () => {}, remove: () => {} },
  }

  const readUsage = async (input: any) => {
    quotaReads.push(input)
    return OFFICIAL_USAGE
  }

  const ctx = {
    options: {
      cwd: dir,
      timeoutMs: 20_000,
      logFile: join(dir, "calls.jsonl"),
      variants: {
        qodercn: {
          cliPath: FAKE_CN_CLI,
          readUsage,
          // 始终注入抓取器：避免单元测试触发真实提取器的 --list-models spawn。
          fetchPricing: async () => {
            if (options.pricing === undefined) return null
            pricingFetches.cn += 1
            return options.pricing
          },
        },
        qoder: {
          cliPath: FAKE_INTL_CLI,
          readUsage,
          fetchPricing: async () => {
            if (options.intlPricing === undefined) return null
            pricingFetches.intl += 1
            return options.intlPricing
          },
        },
      },
    },
    location: { directory: dir },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transformCallback = callback
        callback(editor)
        return { dispose: async () => {} }
      },
      reload: async () => {
        reloads.count += 1
        // OpenCode 的 reload 会重放现有 transform；测试里同样重放，才能看到目录更新。
        transformCallback?.(editor)
      },
    },
    command: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          add: (definition: any) => commands.push(definition),
        })
        return { dispose: async () => {} }
      },
    },
    aisdk: {
      hook: async (name: string, callback: (input: any) => void, hookOptions: any) => {
        assert.equal(name, "sdk")
        sdkHooks.push({ callback, options: hookOptions })
        return { dispose: async () => {} }
      },
    },
    session: {
      synthetic: async (input: any) => {
        synthetic.push(input)
        return { id: "synthetic-1", sessionID: input.sessionID, time: { created: Date.now() }, type: "synthetic", payload: { text: input.text }, delivery: input.delivery }
      },
    },
    rpc: {
      register: async (definition: any, handlers: any) => {
        rpcDefinitions.push(definition)
        rpcHandlers.push(handlers)
        return {
          dispose: async () => {
            rpcState.disposed += 1
          },
        }
      },
    },
  }

  return { ctx, providerAdds, commands, sdkHooks, synthetic, rpcDefinitions, rpcHandlers, rpcDisposed: rpcState, quotaReads, pricingFetches, reloads }
}

test("the plugin registers both variant providers with the aisdk package", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.providerAdds.length, 2)
  const cn = harness.providerAdds[0]
  assert.equal(cn.info.id, "qodercn")
  assert.equal(cn.info.name, "QoderCN (Credits)")
  assert.equal(cn.info.activation, "enabled")
  const intl = harness.providerAdds[1]
  assert.equal(intl.info.id, "qoder")
  assert.equal(intl.info.name, "Qoder (Credits)")
  assert.equal(intl.info.activation, "enabled")

  const expected = fileURLToPath(new URL("../provider.mjs", import.meta.url))
  assert.equal(cn.info.package, `aisdk:file://${expected}`)
  assert.equal(intl.info.package, `aisdk:file://${expected}`)
})

test("the plugin registers the discovered models of each variant with text and image capabilities", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const cnModels = harness.providerAdds[0].models
  assert.deepEqual(
    cnModels.map((model: any) => model.id),
    ["auto", "fast", "qwen3-8-max"],
  )
  assert.equal(cnModels[0].modelID, "Auto")
  assert.equal(cnModels[0].providerID, "qodercn")
  assert.deepEqual(cnModels[0].capabilities, {
    tools: true,
    input: ["text", "image"],
    output: ["text"],
    reasoning: { supported: true, effort: ["none", "low", "medium", "high", "xhigh", "max"] },
  })
  assert.deepEqual(cnModels[0].limit, { context: 200_000, output: 32_000 })
  assert.deepEqual(cnModels[0].cost, [])
  assert.equal(cnModels[0].package, harness.providerAdds[0].info.package)

  const intlModels = harness.providerAdds[1].models
  assert.equal(intlModels.length, 16)
  assert.deepEqual(
    intlModels.slice(0, 6).map((model: any) => model.id),
    ["auto", "ultimate", "fast", "efficient", "sonus", "cantus"],
  )
  assert.equal(intlModels[0].providerID, "qoder")
  assert.equal(intlModels[0].modelID, "Auto")
})

test("the plugin registers a /qoder command", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.commands.length, 1)
  assert.equal(harness.commands[0].name, "qoder")
  assert.match(harness.commands[0].description, /Qoder provider/)
})

test("each variant gets its own scoped aisdk hook", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.sdkHooks.length, 2)
  assert.deepEqual(harness.sdkHooks.map((hook) => hook.options?.providerID), ["qodercn", "qoder"])

  const cnInput: any = { model: { providerID: "qodercn" } }
  harness.sdkHooks[0]!.callback(cnInput)
  assert.equal(cnInput.sdk.provider, "qodercn")
  const cnModel = cnInput.sdk.languageModel("Auto")
  assert.equal(cnModel.specificationVersion, "v3")
  assert.equal(cnModel.modelId, "Auto")

  const intlInput: any = { model: { providerID: "qoder" } }
  harness.sdkHooks[1]!.callback(intlInput)
  assert.equal(intlInput.sdk.provider, "qoder")
})

test("/qoder models lists the selectable model IDs of the CN variant", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder models" }, delivery: "steer" })

  assert.equal(harness.synthetic.length, 1)
  const text = harness.synthetic[0].text as string
  assert.match(text, /qodercn\/auto/)
  assert.match(text, /qodercn\/fast/)
  assert.match(text, /qodercn\/qwen3-8-max/)
})

test("/qoder intl models lists the overseas model IDs", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder intl models" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /qoder\/ultimate/)
  assert.match(text, /qoder\/qwen4-max/)
  assert.equal(/qodercn\//.test(text), false)
})

test("/qoder status reports the CLI, the models and the log file", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /QoderCN \(Credits\) provider status \(qodercn\)/)
  assert.match(text, /CLI:/)
  assert.match(text, /Auth: ok/)
  assert.match(text, /Models: 3/)
  assert.match(text, /Log:/)
})

test("/qoder intl status reports the overseas variant", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder global status" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /Qoder \(Credits\) provider status/)
  assert.match(text, /Models: 16/)
})

test("/qoder login explains the terminal login without faking a success", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder login" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /login/)
  assert.equal(/successfully logged in/i.test(text), false)
})

test("/qoder intl login points at the overseas CLI", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder intl login" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /fake-qoder-intl\.mjs login/)
  assert.match(text, /\/qoder intl refresh/)
})

test("/qoder refresh reloads the provider", async () => {
  const harness = createHarness()
  let reloaded = 0
  harness.ctx.provider.reload = async () => {
    reloaded += 1
  }
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder refresh" }, delivery: "steer" })

  assert.equal(reloaded, 1)
  assert.match(harness.synthetic[0].text as string, /Refreshed the QoderCN \(Credits\) model catalog/)
})

test("/qoder intl refresh refreshes the overseas catalog", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder intl refresh" }, delivery: "steer" })

  assert.match(harness.synthetic[0].text as string, /Refreshed the Qoder \(Credits\) model catalog: 16 models/)
})

test("refreshing one location syncs the catalog to every loaded location", async () => {
  const recordFile = join(mkdtempSync(join(tmpdir(), "qoder-sync-test-")), "list-models.jsonl")
  const previousModels = process.env.FAKE_QODER_MODELS
  const previousRecord = process.env.FAKE_QODER_LIST_RECORD
  const harnessA = createHarness()
  const harnessB = createHarness()
  let cleanupA: (() => Promise<void> | void) | undefined
  let cleanupB: (() => Promise<void> | void) | undefined

  try {
    process.env.FAKE_QODER_MODELS = "Auto\nFast"
    process.env.FAKE_QODER_LIST_RECORD = recordFile
    cleanupA = (await QoderProviderPlugin.setup(harnessA.ctx as never)) ?? undefined
    cleanupB = (await QoderProviderPlugin.setup(harnessB.ctx as never)) ?? undefined

    // 两个 location 初始各发现一次（每个变体一次：CN + 海外，共 4 次）；
    // 第二个 location 之后不得再执行发现。
    assert.equal(listCalls(recordFile).length, 4)
    assert.equal(harnessB.reloads.count, 0)

    process.env.FAKE_QODER_MODELS = "Auto\nFast\nSynced"
    await harnessA.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder refresh" }, delivery: "steer" })

    assert.equal(harnessA.reloads.count, 1)
    assert.equal(harnessB.reloads.count, 1)
    const latestB = harnessB.providerAdds[harnessB.providerAdds.length - 2]
    assert.deepEqual(
      latestB.models.map((model: any) => model.id),
      ["auto", "fast", "synced"],
    )

    const calls = listCalls(recordFile)
    // 只有 CN 变体被刷新：4 次初始发现 + 1 次刷新发现。
    assert.equal(calls.length, 5)
    assert.equal(calls.filter((call) => call.cwd === harnessB.ctx.location.directory).length, 2)
  } finally {
    await cleanupA?.()
    await cleanupB?.()
    if (previousModels === undefined) delete process.env.FAKE_QODER_MODELS
    else process.env.FAKE_QODER_MODELS = previousModels
    if (previousRecord === undefined) delete process.env.FAKE_QODER_LIST_RECORD
    else process.env.FAKE_QODER_LIST_RECORD = previousRecord
  }
})

function listCalls(file: string): any[] {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

test("the plugin registers the qoder RPC contract", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.rpcDefinitions.length, 1)
  assert.equal(harness.rpcDefinitions[0].id, "qoder")
  assert.deepEqual(Object.keys(harness.rpcDefinitions[0].methods), ["execute", "stats", "quota", "pricing"])
})

test("the RPC and the server command answer with the same text", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder models" }, delivery: "steer" })
  const result = await harness.rpcHandlers[0].execute({ text: "/qoder models" }, {} as never)

  assert.equal(result.text, harness.synthetic[0].text)
  assert.match(result.text as string, /qodercn\/auto/)
})

test("the RPC builds the status text without touching the session", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const result = await harness.rpcHandlers[0].execute({ text: "status" }, {} as never)

  assert.match(result.text as string, /QoderCN \(Credits\) provider status \(qodercn\)/)
  assert.match(result.text as string, /Auth: ok/)
  assert.equal(harness.synthetic.length, 0)
})

test("the quota RPC returns official values and serves the second read from cache", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const first = await harness.rpcHandlers[0].quota({ refresh: false }, {} as never)
  assert.equal(first.available, true)
  assert.equal(first.used, 6872)
  assert.equal(first.total, 10000)
  assert.equal(first.remaining, 3128)
  assert.equal(first.percentage, 69)
  assert.equal(first.cached, false)
  const second = await harness.rpcHandlers[0].quota({}, {} as never)
  assert.equal(second.cached, true)
  assert.equal(harness.quotaReads.length, 1)

  const status = await harness.rpcHandlers[0].execute({ text: "status" }, {} as never)
  assert.match(status.text, /Quota: 6,872 \/ 10,000 used \(69%\)/)
  assert.match(status.text, /Quota source: QoderCN CLI \/usage/)
  assert.equal(harness.quotaReads.length, 2)
})

test("the quota RPC serves each variant from its own store", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.rpcHandlers[0].quota({ refresh: false }, {} as never)
  const intl = await harness.rpcHandlers[0].quota({ variant: "qoder", refresh: false }, {} as never)

  assert.equal(intl.available, true)
  assert.equal(intl.source, "Qoder CLI /usage")
  // 两个变体各读一次官方 /usage，互不共享缓存。
  assert.equal(harness.quotaReads.length, 2)
})

test("the pricing RPC returns the injected snapshot and serves the second read from cache", async () => {
  const harness = createHarness({ pricing: PRICING_SNAPSHOT })
  await QoderProviderPlugin.setup(harness.ctx as never)

  const first = await harness.rpcHandlers[0].pricing({ refresh: false }, {} as never)
  assert.equal(first.source, "fixture")
  assert.equal(first.models[0].modelKey, "Qwen3.8-Max")
  const second = await harness.rpcHandlers[0].pricing({}, {} as never)
  assert.equal(second.models[0].priceFactor, 0.4)
  assert.equal(harness.pricingFetches.cn, 1)
  assert.equal(harness.pricingFetches.intl, 0)
})

test("the pricing RPC serves the overseas snapshot of its own variant", async () => {
  const harness = createHarness({ pricing: PRICING_SNAPSHOT, intlPricing: INTL_PRICING_SNAPSHOT })
  await QoderProviderPlugin.setup(harness.ctx as never)

  const intl = await harness.rpcHandlers[0].pricing({ variant: "qoder" }, {} as never)

  assert.equal(intl.source, "fixture-intl")
  assert.equal(intl.models[0].modelKey, "Ultimate")
  assert.equal(intl.models[0].promotion?.timezone, "Asia/Singapore")
  assert.equal(harness.pricingFetches.intl, 1)
})

test("/qoder models and status show the per-model factor and the low-peak summary", async () => {
  const harness = createHarness({ pricing: PRICING_SNAPSHOT })
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder models" }, delivery: "steer" })
  const modelsText = harness.synthetic[0].text as string
  assert.match(modelsText, /Qwen3\.8-Max\s+0\.40x 低峰 · .+后恢复 0\.80x/)
  assert.match(modelsText, /- qodercn\/auto\s+Auto  1\.00x/)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder status" }, delivery: "steer" })
  const statusText = harness.synthetic[1].text as string
  assert.match(statusText, /- Pricing: 低峰进行中/)
  assert.equal(harness.pricingFetches.cn, 1)
})

test("/qoder refresh also refreshes the pricing snapshot", async () => {
  const harness = createHarness({ pricing: PRICING_SNAPSHOT })
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder refresh" }, delivery: "steer" })
  assert.equal(harness.pricingFetches.cn, 1)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder refresh" }, delivery: "steer" })
  assert.equal(harness.pricingFetches.cn, 2)
})

test("the plugin disposes the RPC registration when it is unloaded", async () => {
  const harness = createHarness()
  const cleanup = await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.rpcDisposed.disposed, 0)
  await cleanup?.()
  assert.equal(harness.rpcDisposed.disposed, 1)
})

test("the stats RPC aggregates the call log without running a model", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  appendFileSync(
    harness.ctx.options.logFile,
    [
      JSON.stringify({ ts: "2000-01-01T00:00:00.000Z", provider: "qoder", model: "old", credits: 7 }),
      JSON.stringify({ ts: new Date().toISOString(), provider: "qoder", model: "auto", credits: 0.5 }),
    ]
      .map((line) => `${line}\n`)
      .join(""),
  )

  const stats = await harness.rpcHandlers[0].stats({} as never, {} as never)

  assert.equal(stats.provider, "qodercn")
  // 0.2.x 的旧记录只有 provider 字段（当时只有 CN 变体），归 CN。
  assert.equal(stats.totalCalls, 2)
  assert.equal(stats.totalCredits, 7.5)
  assert.equal(stats.todayCalls, 1)
  assert.equal(stats.todayCredits, 0.5)
  assert.equal(stats.lastModel, "auto")
  assert.equal(stats.lastCredits, 0.5)
  assert.equal(stats.lastError, false)
  assert.equal(stats.authenticated, true)
  assert.equal(stats.models, 3)
  assert.equal(stats.permissionMode, "bypass_permissions")
  assert.equal(typeof stats.cliVersion, "string")
  // stats 调用不碰会话、模型链路或官方配额 PTY。
  assert.equal(harness.synthetic.length, 0)
  assert.equal(harness.quotaReads.length, 0)
})

test("the stats RPC keeps the two variants apart", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  appendFileSync(
    harness.ctx.options.logFile,
    [
      JSON.stringify({ ts: new Date().toISOString(), variant: "qodercn", provider: "qodercn", model: "auto", credits: 1 }),
      JSON.stringify({ ts: new Date().toISOString(), variant: "qoder", provider: "qoder", model: "ultimate", credits: 2 }),
    ]
      .map((line) => `${line}\n`)
      .join(""),
  )

  const cn = await harness.rpcHandlers[0].stats({} as never, {} as never)
  const intl = await harness.rpcHandlers[0].stats({ variant: "qoder" } as never, {} as never)

  assert.equal(cn.provider, "qodercn")
  assert.equal(cn.totalCalls, 1)
  assert.equal(cn.totalCredits, 1)
  assert.equal(cn.lastModel, "auto")
  assert.equal(intl.provider, "qoder")
  assert.equal(intl.totalCalls, 1)
  assert.equal(intl.totalCredits, 2)
  assert.equal(intl.lastModel, "ultimate")
  assert.equal(intl.models, 16)
})

test("the stats RPC returns zeros when the call log is missing", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const stats = await harness.rpcHandlers[0].stats({} as never, {} as never)

  assert.equal(stats.totalCalls, 0)
  assert.equal(stats.totalCredits, 0)
  assert.equal(stats.todayCalls, 0)
  assert.equal(stats.lastModel, "")
  assert.equal(stats.lastAt, "")
})

test("an empty model catalog falls back to the placeholder catalog", async () => {
  const harness = createHarness()
  const previous = process.env.FAKE_QODER_MODELS
  process.env.FAKE_QODER_MODELS = ""
  try {
    await QoderProviderPlugin.setup(harness.ctx as never)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODELS
    else process.env.FAKE_QODER_MODELS = previous
  }

  assert.deepEqual(
    harness.providerAdds[0].models.map((model: any) => model.id),
    ["auto", "fast"],
  )

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder status" }, delivery: "steer" })
  const text = harness.synthetic[0].text as string
  assert.match(text, /Auth: unavailable/)
  assert.match(text, /empty model catalog/)
})

test("/qoder refresh never lets a stale slow discovery overwrite the newer catalog", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const previousModels = process.env.FAKE_QODER_MODELS
  const previousDelay = process.env.FAKE_QODER_DISCOVERY_DELAY_MS
  const refresh = () =>
    harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder refresh" }, delivery: "steer" })

  try {
    process.env.FAKE_QODER_MODELS = "Slow One"
    process.env.FAKE_QODER_DISCOVERY_DELAY_MS = "500"
    const stale = refresh()

    process.env.FAKE_QODER_MODELS = "Fast Two"
    process.env.FAKE_QODER_DISCOVERY_DELAY_MS = "0"
    const current = refresh()

    await Promise.all([stale, current])
  } finally {
    if (previousModels === undefined) delete process.env.FAKE_QODER_MODELS
    else process.env.FAKE_QODER_MODELS = previousModels
    if (previousDelay === undefined) delete process.env.FAKE_QODER_DISCOVERY_DELAY_MS
    else process.env.FAKE_QODER_DISCOVERY_DELAY_MS = previousDelay
  }

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder models" }, delivery: "steer" })
  const text = harness.synthetic[harness.synthetic.length - 1]!.text as string
  assert.match(text, /qodercn\/fast-two/)
  assert.equal(/slow-one/.test(text), false)
})

test("every model registers the reasoning effort variants and capabilities", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const expectations = ["none", "low", "medium", "high", "xhigh", "max"]
  for (const added of harness.providerAdds) {
    for (const model of added.models) {
      assert.deepEqual(model.capabilities.reasoning, { supported: true, effort: expectations })
      assert.deepEqual(model.variants.map((variant: any) => variant.id), expectations)
      assert.deepEqual(model.variants[0], { id: "none", name: "None", settings: { reasoningEffort: "none" } })
      assert.deepEqual(model.variants[5], { id: "max", name: "Max", settings: { reasoningEffort: "max" } })
    }
  }
})
