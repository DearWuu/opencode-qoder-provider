import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { QoderProviderPlugin } from "../index.ts"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))
const OFFICIAL_USAGE = readFileSync(fileURLToPath(new URL("./fixtures/official-usage.txt", import.meta.url)), "utf8")

interface Harness {
  ctx: any
  providerAdds: any[]
  commands: any[]
  sdkHooks: Array<(input: any) => void>
  synthetic: any[]
  rpcDefinitions: any[]
  rpcHandlers: any[]
  rpcDisposed: { disposed: number }
  quotaReads: any[]
  reloads: { count: number }
}

function createHarness(options: { directory?: string } = {}): Harness {
  const dir = options.directory ?? mkdtempSync(join(tmpdir(), "qoder-plugin-test-"))
  const providerAdds: any[] = []
  const commands: any[] = []
  const sdkHooks: Array<(input: any) => void> = []
  const synthetic: any[] = []
  const rpcDefinitions: any[] = []
  const rpcHandlers: any[] = []
  const rpcState = { disposed: 0 }
  const quotaReads: any[] = []
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

  const ctx = {
    options: {
      cliPath: FAKE_CLI,
      cwd: dir,
      timeoutMs: 20_000,
      logFile: join(dir, "calls.jsonl"),
      readUsage: async (input: any) => {
        quotaReads.push(input)
        return OFFICIAL_USAGE
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
      hook: async (name: string, callback: (input: any) => void) => {
        assert.equal(name, "sdk")
        sdkHooks.push(callback)
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

  return { ctx, providerAdds, commands, sdkHooks, synthetic, rpcDefinitions, rpcHandlers, rpcDisposed: rpcState, quotaReads, reloads }
}

test("the plugin registers the qoder provider with the aisdk package", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.providerAdds.length, 1)
  const added = harness.providerAdds[0]
  assert.equal(added.info.id, "qoder")
  assert.equal(added.info.name, "Qoder (Credits)")
  assert.equal(added.info.activation, "enabled")
  assert.match(added.info.package, /^aisdk:file:\/\/\/.*provider\.mjs$/)

  const expected = fileURLToPath(new URL("../provider.mjs", import.meta.url))
  assert.equal(added.info.package, `aisdk:file://${expected}`)
})

test("the plugin registers the discovered models with text only capabilities", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const models = harness.providerAdds[0].models
  assert.deepEqual(
    models.map((model: any) => model.id),
    ["auto", "fast", "qwen3-8-max"],
  )
  assert.equal(models[0].modelID, "Auto")
  assert.equal(models[0].providerID, "qoder")
  assert.deepEqual(models[0].capabilities, { tools: false, input: ["text"], output: ["text"] })
  assert.deepEqual(models[0].limit, { context: 200_000, output: 32_000 })
  assert.deepEqual(models[0].cost, [])
  assert.equal(models[0].package, harness.providerAdds[0].info.package)
})

test("the plugin registers a /qoder command", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.commands.length, 1)
  assert.equal(harness.commands[0].name, "qoder")
  assert.match(harness.commands[0].description, /Qoder provider/)
})

test("the aisdk hook exposes the provider factory", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.sdkHooks.length, 1)
  const input: any = { model: { providerID: "qoder" } }
  harness.sdkHooks[0]!(input)
  assert.equal(typeof input.sdk.languageModel, "function")
  const model = input.sdk.languageModel("Auto")
  assert.equal(model.specificationVersion, "v3")
  assert.equal(model.modelId, "Auto")
})

test("/qoder models lists the selectable model IDs", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder models" }, delivery: "steer" })

  assert.equal(harness.synthetic.length, 1)
  const text = harness.synthetic[0].text as string
  assert.match(text, /qoder\/auto/)
  assert.match(text, /qoder\/fast/)
  assert.match(text, /qoder\/qwen3-8-max/)
})

test("/qoder status reports the CLI, the models and the log file", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /Qoder provider status/)
  assert.match(text, /CLI:/)
  assert.match(text, /Auth: ok/)
  assert.match(text, /Models: 3/)
  assert.match(text, /Log:/)
})

test("/qoder login explains the terminal login without faking a success", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder login" }, delivery: "steer" })

  const text = harness.synthetic[0].text as string
  assert.match(text, /login/)
  assert.equal(/successfully logged in/i.test(text), false)
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
  assert.match(harness.synthetic[0].text as string, /Refreshed the Qoder model catalog/)
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

    // 两个 location 初始各发现一次；第二个 location 之后不得再执行发现。
    assert.equal(listCalls(recordFile).length, 2)
    assert.equal(harnessB.reloads.count, 0)

    process.env.FAKE_QODER_MODELS = "Auto\nFast\nSynced"
    await harnessA.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder refresh" }, delivery: "steer" })

    assert.equal(harnessA.reloads.count, 1)
    assert.equal(harnessB.reloads.count, 1)
    const latestB = harnessB.providerAdds[harnessB.providerAdds.length - 1]
    assert.deepEqual(
      latestB.models.map((model: any) => model.id),
      ["auto", "fast", "synced"],
    )

    const calls = listCalls(recordFile)
    assert.equal(calls.length, 3)
    assert.equal(calls.filter((call) => call.cwd === harnessB.ctx.location.directory).length, 1)
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
  assert.deepEqual(Object.keys(harness.rpcDefinitions[0].methods), ["execute", "stats", "quota"])
})

test("the RPC and the server command answer with the same text", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  await harness.commands[0].execute({ sessionID: "session-1", prompt: { text: "/qoder models" }, delivery: "steer" })
  const result = await harness.rpcHandlers[0].execute({ text: "/qoder models" }, {} as never)

  assert.equal(result.text, harness.synthetic[0].text)
  assert.match(result.text as string, /qoder\/auto/)
})

test("the RPC builds the status text without touching the session", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  const result = await harness.rpcHandlers[0].execute({ text: "status" }, {} as never)

  assert.match(result.text as string, /Qoder provider status/)
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
  assert.match(status.text, /Quota source: Qoder CLI \/usage/)
  assert.equal(harness.quotaReads.length, 2)
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

  assert.equal(stats.provider, "qoder")
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
  assert.match(text, /qoder\/fast-two/)
  assert.equal(/slow-one/.test(text), false)
})
