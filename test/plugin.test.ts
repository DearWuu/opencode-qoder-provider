import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { QoderProviderPlugin } from "../index.ts"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))

interface Harness {
  ctx: any
  providerAdds: any[]
  commands: any[]
  sdkHooks: Array<(input: any) => void>
  synthetic: any[]
  rpcDefinitions: any[]
  rpcHandlers: any[]
  rpcDisposed: { disposed: number }
}

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "qoder-plugin-test-"))
  const providerAdds: any[] = []
  const commands: any[] = []
  const sdkHooks: Array<(input: any) => void> = []
  const synthetic: any[] = []
  const rpcDefinitions: any[] = []
  const rpcHandlers: any[] = []
  const rpcState = { disposed: 0 }

  const ctx = {
    options: { cliPath: FAKE_CLI, cwd: dir, timeoutMs: 20_000, logFile: join(dir, "calls.jsonl") },
    location: { directory: dir },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        callback({
          list: () => [],
          get: () => undefined,
          add: (input: any) => providerAdds.push(input),
          update: () => {},
          remove: () => {},
          models: { set: () => {}, update: () => {}, remove: () => {} },
        })
        return { dispose: async () => {} }
      },
      reload: async () => {},
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

  return { ctx, providerAdds, commands, sdkHooks, synthetic, rpcDefinitions, rpcHandlers, rpcDisposed: rpcState }
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

test("the plugin registers the qoder RPC contract", async () => {
  const harness = createHarness()
  await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.rpcDefinitions.length, 1)
  assert.equal(harness.rpcDefinitions[0].id, "qoder")
  assert.deepEqual(Object.keys(harness.rpcDefinitions[0].methods), ["execute"])
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

test("the plugin disposes the RPC registration when it is unloaded", async () => {
  const harness = createHarness()
  const cleanup = await QoderProviderPlugin.setup(harness.ctx as never)

  assert.equal(harness.rpcDisposed.disposed, 0)
  await cleanup?.()
  assert.equal(harness.rpcDisposed.disposed, 1)
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
