import { test } from "node:test"
import assert from "node:assert/strict"

import { buildModelCatalog, modelsEquivalent, parseModelEntry, parseModelList, toModelId } from "../src/models.mjs"

test("toModelId converts Qoder model names to lowercase kebab-case", () => {
  assert.equal(toModelId("Auto"), "auto")
  assert.equal(toModelId("Fast"), "fast")
  assert.equal(toModelId("Qwen3.8-Max"), "qwen3-8-max")
  assert.equal(toModelId("DeepSeek-V4-Pro"), "deepseek-v4-pro")
  assert.equal(toModelId("GLM-5.3"), "glm-5-3")
  assert.equal(toModelId("Kimi-K2.8-Preview"), "kimi-k2-8-preview")
  assert.equal(toModelId("MiniMax-M3.1-Flash"), "minimax-m3-1-flash")
  assert.equal(toModelId("  Step-5-Preview  "), "step-5-preview")
})

test("parseModelList drops the MODEL header and keeps every model", () => {
  const list = parseModelList("MODEL\nAuto\nFast\nQwen3.8-Max\n")
  assert.deepEqual(list, [
    { name: "Auto", modelID: "Auto" },
    { name: "Fast", modelID: "Fast" },
    { name: "Qwen3.8-Max", modelID: "Qwen3.8-Max" },
  ])
})

test("parseModelList extracts the model key of custom models", () => {
  assert.deepEqual(parseModelEntry("My Custom (my-custom)"), { name: "My Custom", modelID: "my-custom" })
  assert.deepEqual(parseModelEntry("Auto"), { name: "Auto", modelID: "Auto" })
})

test("buildModelCatalog keeps the Qoder modelID and resolves ID conflicts", () => {
  const catalog = buildModelCatalog([
    { name: "Auto", modelID: "Auto" },
    { name: "Fast", modelID: "Fast" },
    { name: "My Model", modelID: "My Model" },
    { name: "My-Model", modelID: "My-Model" },
  ])

  assert.deepEqual(catalog, [
    { id: "auto", modelID: "Auto", name: "Auto" },
    { id: "fast", modelID: "Fast", name: "Fast" },
    { id: "my-model", modelID: "My Model", name: "My Model" },
    { id: "my-model-2", modelID: "My-Model", name: "My-Model" },
  ])
})

test("modelsEquivalent ignores case so Auto matches modelUsage.auto", () => {
  assert.equal(modelsEquivalent("Auto", "auto"), true)
  assert.equal(modelsEquivalent("auto", "Auto"), true)
  assert.equal(modelsEquivalent("Qwen3.8-Max", "qwen3.8-max"), true)
  assert.equal(modelsEquivalent("Fast", "auto"), false)
  assert.equal(modelsEquivalent("DeepSeek-V4-Pro", "deepseek-v4-pro-flash"), false)
  assert.equal(modelsEquivalent("", "auto"), false)
})
