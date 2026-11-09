import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createQoder } from "../src/provider.mjs"
import { MAX_PROMPT_BYTES } from "../src/options.mjs"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))

function tempDir() {
  return mkdtempSync(join(tmpdir(), "qoder-provider-test-"))
}

function makeProvider(overrides: Record<string, unknown> = {}) {
  const dir = tempDir()
  const logFile = join(dir, "calls.jsonl")
  const provider = createQoder({
    cliPath: FAKE_CLI,
    cwd: dir,
    timeoutMs: 20_000,
    logFile,
    ...overrides,
  })
  return { provider, dir, logFile }
}

const PROMPT = [
  { role: "system", content: "be brief" },
  { role: "user", content: [{ type: "text", text: "hello" }] },
]

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
  assert.equal(metadata.actualModel, "auto")
  assert.equal(metadata.modelFallback, false)
  assert.equal(metadata.isError, false)

  const logged = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n")[0]!)
  assert.equal(logged.credits, 0.25)
  assert.equal(logged.model, "Auto")
  assert.equal(logged.actualModel, "auto")
  assert.equal(JSON.stringify(logged).includes("be brief"), false)
})

test("doGenerate does not report a fallback for Auto served by modelUsage.auto", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const result = await model.doGenerate({ prompt: PROMPT })
  assert.equal(result.warnings.length, 0)
  assert.equal((result.providerMetadata!.qoder as Record<string, unknown>).modelFallback, false)
  assert.equal((result.content[0] as { text: string }).text.includes("fallback"), false)
})

test("doGenerate appends a visible warning when Qoder falls back to another model", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Fast")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "fallback"
  try {
    const result = await model.doGenerate({ prompt: PROMPT })
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0]!.type, "other")
    assert.match((result.warnings[0] as { message: string }).message, /fallback/)
    assert.match((result.content[0] as { text: string }).text, /fallback/i)
    assert.equal((result.providerMetadata!.qoder as Record<string, unknown>).modelFallback, true)
    assert.equal((result.providerMetadata!.qoder as Record<string, unknown>).actualModel, "auto")
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

test("doStream emits the V3 stream events", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")

  const { stream } = await model.doStream({ prompt: PROMPT })
  const parts: any[] = []
  for await (const part of stream as unknown as AsyncIterable<any>) {
    parts.push(part)
  }

  assert.deepEqual(
    parts.map((part) => part.type),
    ["stream-start", "text-start", "text-delta", "text-end", "finish"],
  )
  assert.equal(parts[2]!.delta, "ok: Auto")
  assert.equal(parts[4]!.finishReason.unified, "stop")
  assert.equal(parts[4]!.usage.outputTokens.total, 5)
  assert.equal((parts[4]!.providerMetadata.qoder as Record<string, unknown>).credits, 0.25)
})

test("doStream reports CLI failures as an error part", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "crash"
  try {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)
    assert.equal(parts[parts.length - 1]!.type, "error")
    assert.match(String(parts[parts.length - 1]!.error.message), /fatal: qoder exploded/)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
})

test("an aborted call rejects with an AbortError", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "hang"
  const controller = new AbortController()
  try {
    const promise = model.doGenerate({ prompt: PROMPT, abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    await assert.rejects(promise, (error: unknown) => {
      assert.equal((error as Error).name, "AbortError")
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
})

test("a hanging call is aborted by the timeout", async () => {
  const { provider } = makeProvider({ timeoutMs: 300 })
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "hang"
  try {
    await assert.rejects(model.doGenerate({ prompt: PROMPT }), /timed out after 300 ms/)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
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
