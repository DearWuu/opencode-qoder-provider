import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))

test("the provider runtime loads through a file:// URL and exposes createQoder", async () => {
  const providerFile = fileURLToPath(new URL("../provider.mjs", import.meta.url))
  const module = await import(pathToFileURL(providerFile).href)

  assert.equal(typeof module.createQoder, "function")
  assert.equal(typeof module.model, "function")

  const dir = mkdtempSync(join(tmpdir(), "qoder-runtime-test-"))
  const provider = module.createQoder({
    cliPath: FAKE_CLI,
    cwd: dir,
    timeoutMs: 20_000,
    logFile: join(dir, "calls.jsonl"),
  })

  assert.equal(provider.specificationVersion, "v3")
  assert.equal(provider.provider, "qoder")
  assert.equal(typeof provider.languageModel, "function")

  const model = provider.languageModel("Auto")
  assert.equal(model.specificationVersion, "v3")
  assert.equal(model.provider, "qoder")
  assert.equal(model.modelId, "Auto")
  assert.equal(typeof model.doGenerate, "function")
  assert.equal(typeof model.doStream, "function")
})

test("the native model(modelID, settings) protocol also returns a LanguageModelV3", async () => {
  const providerFile = fileURLToPath(new URL("../provider.mjs", import.meta.url))
  const module = await import(pathToFileURL(providerFile).href)

  const dir = mkdtempSync(join(tmpdir(), "qoder-runtime-test-"))
  const model = module.model("Auto", { cliPath: FAKE_CLI, cwd: dir, logFile: join(dir, "calls.jsonl") })
  assert.equal(model.specificationVersion, "v3")
  assert.equal(model.modelId, "Auto")
})
