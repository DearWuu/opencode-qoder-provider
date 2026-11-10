import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { DEFAULT_PERMISSION_MODE, MAX_PROMPT_BYTES } from "../src/options.mjs"
import { ModelFallbackError } from "../src/result.mjs"
import { makeProvider, tempDir, withFakeEnv, PROMPT } from "./provider-test-helpers.ts"

test("doGenerate returns an AI SDK V3 result with the Qoder credits", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")

  const result = await model.doGenerate({ prompt: PROMPT })

  assert.equal(result.content.length, 1)
  assert.equal(result.content[0]!.type, "text")
  assert.equal(result.content[0]!.text, "ok: Auto")
  assert.deepEqual(result.finishReason, { unified: "stop", raw: "end_turn" })
  assert.equal(result.usage.inputTokens.total, 10)
  assert.equal(result.usage.outputTokens.total, 5)
  assert.equal(result.usage.inputTokens.cacheRead, 0)
  assert.equal(result.warnings.length, 0)

  const metadata = result.providerMetadata!.qoder as Record<string, unknown>
  assert.equal(metadata.credits, 0.25)
  assert.equal(metadata.sessionId, "fake-session")
  assert.equal(metadata.requestedModel, "Auto")
  assert.equal(metadata.actualModel, "Auto")
  assert.equal(metadata.modelFallback, false)
  assert.equal(metadata.usageModelKey, "auto")
  assert.deepEqual(metadata.usageModelKeys, ["auto"])
  assert.equal(metadata.isError, false)

  const logged = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n")[0]!)
  assert.equal(logged.credits, 0.25)
  assert.equal(logged.model, "Auto")
  assert.equal(logged.actualModel, "Auto")
  assert.equal(logged.usageModelKey, "auto")
  assert.deepEqual(logged.usageModelKeys, ["auto"])
  assert.equal(JSON.stringify(logged).includes("be brief"), false)
})

test("doGenerate treats Auto as the requested model and records modelUsage.auto separately", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const result = await model.doGenerate({ prompt: PROMPT })
  const metadata = result.providerMetadata!.qoder as Record<string, unknown>
  assert.equal(result.warnings.length, 0)
  assert.equal(metadata.modelFallback, false)
  assert.equal(metadata.actualModel, "Auto")
  assert.equal(metadata.usageModelKey, "auto")
  assert.equal((result.content[0] as { text: string }).text.includes("fallback"), false)
})

for (const requestedModel of ["DeepSeek-Flash", "Fast"]) {
  test(`doGenerate does not infer a fallback when ${requestedModel} only has modelUsage.auto`, async () => {
    const { provider, logFile } = makeProvider()
    const model = provider.languageModel(requestedModel)
    const previous = process.env.FAKE_QODER_MODE
    process.env.FAKE_QODER_MODE = "usage-auto"
    try {
      const result = await model.doGenerate({ prompt: PROMPT })
      const metadata = result.providerMetadata!.qoder as Record<string, unknown>
      assert.equal(result.warnings.length, 0)
      assert.equal((result.content[0] as { text: string }).text, `ok: ${requestedModel}`)
      assert.equal(metadata.actualModel, requestedModel)
      assert.equal(metadata.modelFallback, false)
      assert.equal(metadata.usageModelKey, "auto")
      assert.deepEqual(metadata.usageModelKeys, ["auto"])

      const logged = JSON.parse(readFileSync(logFile, "utf8").trim())
      assert.equal(logged.actualModel, requestedModel)
      assert.equal(logged.usageModelKey, "auto")
      assert.equal(logged.modelFallback, false)
      assert.equal(logged.isError, false)
    } finally {
      if (previous === undefined) delete process.env.FAKE_QODER_MODE
      else process.env.FAKE_QODER_MODE = previous
    }
  })
}

test("doGenerate rejects an explicit CLI model fallback and logs the failed call", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("efficient")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "fallback"
  try {
    await assert.rejects(model.doGenerate({ prompt: PROMPT }), (error: unknown) => {
      assert.equal(error instanceof ModelFallbackError, true)
      assert.equal((error as Error).name, "ModelFallbackError")
      assert.equal((error as ModelFallbackError).actualModel, "auto")
      return true
    })

    const lines = readFileSync(logFile, "utf8").trim().split("\n")
    assert.equal(lines.length, 1)
    const logged = JSON.parse(lines[0]!)
    assert.equal(logged.model, "efficient")
    assert.equal(logged.actualModel, "auto")
    assert.equal(logged.modelFallback, true)
    assert.equal(logged.usageModelKey, "auto")
    assert.equal(logged.credits, 0.25)
    assert.equal(logged.sessionId, "fake-session")
    assert.equal(logged.isError, true)
    assert.equal(logged.exitCode, 0)
    assert.equal(typeof logged.durationMs, "number")
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
})

test("doGenerate reports is_error results with the error finish reason", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "error"
  try {
    const result = await model.doGenerate({ prompt: PROMPT })
    assert.equal(result.finishReason.unified, "error")
    assert.equal((result.content[0] as { text: string }).text, "Qoder run failed")
    assert.equal((result.providerMetadata!.qoder as Record<string, unknown>).isError, true)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
})

test("additionalDirs and cliTools are passed through to the CLI argv", async () => {
  const extra = join(tempDir(), "extra")
  const { provider, dir } = makeProvider({ additionalDirs: [extra], cliTools: "" })
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  const previousRecord = process.env.FAKE_QODER_RECORD
  process.env.FAKE_QODER_RECORD = record
  try {
    await model.doGenerate({ prompt: PROMPT })
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv[argv.indexOf("--add-dir") + 1], extra)
    assert.deepEqual(argv.slice(argv.indexOf("--tools")), ["--tools", ""])
  } finally {
    if (previousRecord === undefined) delete process.env.FAKE_QODER_RECORD
    else process.env.FAKE_QODER_RECORD = previousRecord
  }
})

test("an oversized prompt is rejected before the CLI is started", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const huge = [{ role: "user" as const, content: [{ type: "text" as const, text: "x".repeat(MAX_PROMPT_BYTES + 10) }] }]
  await assert.rejects(model.doGenerate({ prompt: huge }), /exceeds the 7340032 byte limit/)
  assert.equal(existsSync(logFile) ? readFileSync(logFile, "utf8").length : 0, 0)
})

test("a missing CLI binary produces an actionable error", async () => {
  const { provider } = makeProvider({ cliPath: join(tempDir(), "missing-cli") })
  const model = provider.languageModel("Auto")
  await assert.rejects(model.doGenerate({ prompt: PROMPT }), /Qoder CLI not found/)
})

test("without an explicit permissionMode the CLI is pinned to bypass_permissions", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  const previousMode = process.env.FAKE_QODER_MODE
  const previousPermission = process.env.QODER_PERMISSION_MODE
  const previousRecord = process.env.FAKE_QODER_RECORD
  process.env.FAKE_QODER_MODE = "ok"
  process.env.FAKE_QODER_RECORD = record
  delete process.env.QODER_PERMISSION_MODE
  try {
    await model.doGenerate({ prompt: PROMPT })
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypass_permissions")
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], DEFAULT_PERMISSION_MODE)
  } finally {
    if (previousMode === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previousMode
    if (previousRecord === undefined) delete process.env.FAKE_QODER_RECORD
    else process.env.FAKE_QODER_RECORD = previousRecord
    if (previousPermission !== undefined) process.env.QODER_PERMISSION_MODE = previousPermission
  }
})

test("an explicit default permissionMode is still passed through to the CLI", async () => {
  const { provider, dir } = makeProvider({ permissionMode: "default" })
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_RECORD: record }, async () => {
    await model.doGenerate({ prompt: PROMPT })
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "default")
  })
})

test("doGenerate forwards a positive integer maxOutputTokens to --max-output-tokens", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_RECORD: record }, async () => {
    await model.doGenerate({ prompt: PROMPT, maxOutputTokens: 4096 })
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv[argv.indexOf("--max-output-tokens") + 1], "4096")
  })
})

test("invalid maxOutputTokens values never add the CLI flag", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  for (const invalid of [0, -5, 2.5, Number.NaN]) {
    await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_RECORD: record }, async () => {
      await model.doGenerate({ prompt: PROMPT, maxOutputTokens: invalid })
      const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
      assert.equal(argv.includes("--max-output-tokens"), false)
    })
  }
})

test("doGenerate maps a max_tokens stop reason to the unified length finish", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_STOP_REASON: "max_tokens" }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT })
    assert.deepEqual(result.finishReason, { unified: "length", raw: "max_tokens" })
  })
})

test("the split auto/fast modelUsage reports fast as the usage model with credits", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_USAGE_SPLIT: "1" }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT })
    const metadata = result.providerMetadata!.qoder as Record<string, unknown>
    assert.equal(metadata.usageModelKey, "fast")
    assert.deepEqual(metadata.usageModelKeys, ["auto", "fast"])
    assert.equal(metadata.modelCredits, 0.129)
    assert.equal(result.usage.inputTokens.total, 10)

    const logged = JSON.parse(readFileSync(logFile, "utf8").trim())
    assert.equal(logged.usageModelKey, "fast")
    assert.equal(logged.credits, 0.25)
  })
})

test("doGenerate keeps the single-document json mode without partial flags", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_RECORD: record }, async () => {
    await model.doGenerate({ prompt: PROMPT })
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.deepEqual(argv.slice(0, 3), ["-p", "-o", "json"])
    assert.equal(argv.includes("--include-partial-messages"), false)
    assert.equal(argv.includes("stream-json"), false)
  })
})

test("doGenerate approximates zero token counters from usage.context_usage_ratio", async () => {
  const { provider } = makeProvider({ contextLimit: 200_000 })
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "ok", FAKE_QODER_ZERO_USAGE: "1", FAKE_QODER_CONTEXT_RATIO: "0.034375" }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT })
    assert.equal(result.usage.inputTokens.total, 6875)
    const metadata = result.providerMetadata!.qoder as Record<string, unknown>
    assert.equal(metadata.contextUsageRatio, 0.034375)
    assert.equal(metadata.approximatedContextTokens, true)
  })
})
