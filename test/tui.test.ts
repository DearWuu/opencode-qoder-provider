import { test } from "node:test"
import assert from "node:assert/strict"

import { QoderTuiPlugin } from "../tui.ts"

interface Harness {
  context: any
  layers: any[]
  alerts: any[]
  toasts: any[]
  rpcCalls: any[]
  modelInvalidated: any[]
  modelSynced: any[]
}

function createHarness(): Harness {
  const layers: any[] = []
  const alerts: any[] = []
  const toasts: any[] = []
  const rpcCalls: any[] = []
  const modelInvalidated: any[] = []
  const modelSynced: any[] = []

  const context = {
    location: { directory: "/tmp/project" },
    client: {
      rpc: (definition: any) => ({
        execute: async (input: any) => {
          rpcCalls.push({ definition, input })
          if (input?.text === "boom") throw new Error("server unreachable")
          return { text: `answer for ${input.text}` }
        },
      }),
    },
    ui: {
      dialog: {
        alert: async (options: any) => {
          alerts.push(options)
        },
      },
      toast: {
        show: (options: any) => {
          toasts.push(options)
        },
      },
    },
    keymap: {
      layer: (factory: any) => {
        layers.push(factory())
      },
    },
    data: {
      location: {
        default: () => ({ directory: "/tmp/default" }),
        model: {
          invalidate: (location: any) => {
            modelInvalidated.push(location)
          },
          sync: async (location: any) => {
            modelSynced.push(location)
          },
        },
      },
    },
  }

  return { context, layers, alerts, toasts, rpcCalls, modelInvalidated, modelSynced }
}

async function setup(): Promise<Harness> {
  const harness = createHarness()
  await QoderTuiPlugin.setup(harness.context as never)
  return harness
}

function command(harness: Harness) {
  assert.equal(harness.layers.length, 1)
  const layer = harness.layers[0]
  assert.equal(layer.commands.length, 1)
  return layer.commands[0]
}

test("the TUI plugin registers the /qoder slash command with arguments", async () => {
  const harness = await setup()
  const cmd = command(harness)

  assert.deepEqual(cmd.slash, { name: "qoder", arguments: true })
  assert.equal(cmd.id, "qoder.command")
  assert.equal(cmd.palette, true)
  assert.equal(cmd.group, "Qoder")
})

test("the slash command calls the qoder RPC and shows the answer in a dialog", async () => {
  const harness = await setup()
  const cmd = command(harness)

  await cmd.run("status")

  assert.equal(harness.rpcCalls.length, 1)
  assert.equal(harness.rpcCalls[0].definition.id, "qoder")
  assert.deepEqual(harness.rpcCalls[0].input, { text: "status" })
  assert.equal(harness.alerts.length, 1)
  assert.equal(harness.alerts[0].title, "Qoder")
  assert.equal(harness.alerts[0].message, "answer for status")
  assert.equal(harness.toasts.length, 0)
})

test("an empty slash argument still asks for the status", async () => {
  const harness = await setup()
  const cmd = command(harness)

  await cmd.run(undefined)

  assert.deepEqual(harness.rpcCalls[0].input, { text: "" })
  assert.equal(harness.alerts.length, 1)
})

test("a failing RPC call shows an error toast instead of a dialog", async () => {
  const harness = await setup()
  const cmd = command(harness)

  await cmd.run("boom")

  assert.equal(harness.alerts.length, 0)
  assert.equal(harness.toasts.length, 1)
  assert.equal(harness.toasts[0].variant, "error")
  assert.equal(harness.toasts[0].title, "Qoder")
  assert.match(harness.toasts[0].message, /server unreachable/)
})

test("only the refresh command refreshes the model list of the picker", async () => {
  const harness = await setup()
  const cmd = command(harness)

  await cmd.run("status")
  assert.equal(harness.modelInvalidated.length, 0)
  assert.equal(harness.modelSynced.length, 0)

  await cmd.run("refresh")
  assert.equal(harness.modelInvalidated.length, 1)
  assert.equal(harness.modelSynced.length, 1)
  assert.deepEqual(harness.modelInvalidated[0], { directory: "/tmp/project" })
  assert.deepEqual(harness.modelSynced[0], { directory: "/tmp/project" })
})

test("the model list falls back to the default location", async () => {
  const harness = await setup()
  harness.context.location = undefined
  const cmd = command(harness)

  await cmd.run("refresh")

  assert.deepEqual(harness.modelInvalidated[0], { directory: "/tmp/default" })
})
