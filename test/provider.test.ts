import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { MAX_STDOUT_BYTES } from "../src/cli.mjs"
import { DEFAULT_PERMISSION_MODE, MAX_PROMPT_BYTES } from "../src/options.mjs"
import { createQoder } from "../src/provider.mjs"
import { ModelFallbackError } from "../src/result.mjs"

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

test("doStream emits ModelFallbackError without text or finish for an explicit CLI fallback", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("efficient")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "fallback"
  try {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

    assert.deepEqual(parts.map((part) => part.type), ["stream-start", "error"])
    assert.equal(parts[1]!.error instanceof ModelFallbackError, true)
    assert.equal(parts[1]!.error.name, "ModelFallbackError")
    assert.equal(parts[1]!.error.actualModel, "auto")

    const logged = JSON.parse(readFileSync(logFile, "utf8").trim())
    assert.equal(logged.modelFallback, true)
    assert.equal(logged.isError, true)
    assert.equal(logged.credits, 0.25)
    assert.equal(logged.sessionId, "fake-session")
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
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

async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return false
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return false
}

function readLogged(logFile: string): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("cancelling doStream kills the CLI and produces no result log", async () => {
  const { provider, dir, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const pidFile = join(dir, "cli.pid")
  const resultFile = join(dir, "cli-answered")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "slow"
  process.env.FAKE_QODER_PID_FILE = pidFile
  process.env.FAKE_QODER_RESULT_FILE = resultFile
  process.env.FAKE_QODER_DELAY_MS = "8000"
  try {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const reader = (stream as unknown as ReadableStream).getReader()
    const first = await reader.read()
    assert.equal(first.value!.type, "stream-start")
    assert.equal(await waitForFile(pidFile), true, "the fake CLI never started")
    const pid = Number(readFileSync(pidFile, "utf8"))

    await reader.cancel("user stopped")

    // Nothing else may arrive after the cancel.
    const next = await reader.read()
    assert.equal(next.done, true)

    assert.equal(await waitForExit(pid), true, "the fake CLI process tree survived the cancel")
    assert.equal(existsSync(resultFile), false)

    const logged = readLogged(logFile)
    assert.equal(logged.filter((entry) => entry.isError !== true).length, 0)
    for (const entry of logged) assert.equal(entry.aborted, true)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
    delete process.env.FAKE_QODER_PID_FILE
    delete process.env.FAKE_QODER_RESULT_FILE
    delete process.env.FAKE_QODER_DELAY_MS
  }
})

test("an external abortSignal stops doStream with an abort error part only", async () => {
  const { provider, dir, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const pidFile = join(dir, "cli.pid")
  const resultFile = join(dir, "cli-answered")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "slow"
  process.env.FAKE_QODER_PID_FILE = pidFile
  process.env.FAKE_QODER_RESULT_FILE = resultFile
  process.env.FAKE_QODER_DELAY_MS = "8000"
  try {
    const controller = new AbortController()
    const { stream } = await model.doStream({ prompt: PROMPT, abortSignal: controller.signal })
    const reader = (stream as unknown as ReadableStream).getReader()
    const first = await reader.read()
    assert.equal(first.value!.type, "stream-start")
    assert.equal(await waitForFile(pidFile), true, "the fake CLI never started")
    const pid = Number(readFileSync(pidFile, "utf8"))

    controller.abort()

    const error = await reader.read()
    assert.equal(error.done, false)
    assert.equal(error.value!.type, "error")
    assert.equal((error.value!.error as Error).name, "AbortError")
    const end = await reader.read()
    assert.equal(end.done, true)

    assert.equal(await waitForExit(pid), true, "the fake CLI process tree survived the abort")
    assert.equal(existsSync(resultFile), false)

    const logged = readLogged(logFile)
    assert.equal(logged.filter((entry) => entry.isError !== true).length, 0)
    for (const entry of logged) assert.equal(entry.aborted, true)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
    delete process.env.FAKE_QODER_PID_FILE
    delete process.env.FAKE_QODER_RESULT_FILE
    delete process.env.FAKE_QODER_DELAY_MS
  }
})

test("a truncated stdout fails the call instead of returning partial output", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "huge-out"
  process.env.FAKE_QODER_OUT_BYTES = String(MAX_STDOUT_BYTES + 5)
  try {
    await assert.rejects(
      model.doGenerate({ prompt: PROMPT }),
      new RegExp(`stdout exceeded the ${MAX_STDOUT_BYTES} byte limit and was truncated`),
    )
    const logged = readLogged(logFile)
    assert.equal(logged.length, 1)
    assert.equal(logged[0]!.isError, true)
    assert.equal(logged[0]!.aborted, undefined)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
    delete process.env.FAKE_QODER_OUT_BYTES
  }
})

test("without an explicit permissionMode the CLI is pinned to the built-in default", async () => {
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
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], DEFAULT_PERMISSION_MODE)
  } finally {
    if (previousMode === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previousMode
    if (previousRecord === undefined) delete process.env.FAKE_QODER_RECORD
    else process.env.FAKE_QODER_RECORD = previousRecord
    if (previousPermission !== undefined) process.env.QODER_PERMISSION_MODE = previousPermission
  }
})

interface FakeEnvKeys {
  FAKE_QODER_MODE?: string
  FAKE_QODER_PID_FILE?: string
  FAKE_QODER_RECORD?: string
  FAKE_QODER_PARTIAL_DELAY_MS?: string
  FAKE_QODER_ZERO_USAGE?: string
  FAKE_QODER_CONTEXT_RATIO?: string
  FAKE_QODER_RESULT_TEXT?: string
  FAKE_QODER_STOP_REASON?: string
  FAKE_QODER_USAGE_SPLIT?: string
  FAKE_QODER_EMPTY_STOP?: string
}

async function withFakeEnv(overrides: FakeEnvKeys, run: () => Promise<void>) {
  const previous: FakeEnvKeys = {}
  for (const key of Object.keys(overrides) as Array<keyof FakeEnvKeys>) {
    previous[key] = process.env[key]
    const value = overrides[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const key of Object.keys(previous) as Array<keyof FakeEnvKeys>) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test("doStream forwards live text_delta partials without repeating the final text", async () => {
  const { provider, dir } = makeProvider({ contextLimit: 100_000 })
  const model = provider.languageModel("Auto")
  const pidFile = join(dir, "cli.pid")
  await withFakeEnv(
    {
      FAKE_QODER_MODE: "partial",
      FAKE_QODER_PID_FILE: pidFile,
      FAKE_QODER_PARTIAL_DELAY_MS: "80",
      FAKE_QODER_ZERO_USAGE: "1",
      FAKE_QODER_CONTEXT_RATIO: "0.5",
    },
    async () => {
      const { stream } = await model.doStream({ prompt: PROMPT })
      const reader = (stream as unknown as ReadableStream).getReader()
      const parts: any[] = []
      let cliAliveDuringFirstTextDelta = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        if (value.type === "text-delta" && !cliAliveDuringFirstTextDelta) {
          // The delta must arrive while the CLI is still running (partials,
          // not a post-mortem replay of the buffered output).
          const pid = Number(readFileSync(pidFile, "utf8"))
          try {
            process.kill(pid, 0)
            cliAliveDuringFirstTextDelta = true
          } catch {}
        }
      }

      assert.equal(cliAliveDuringFirstTextDelta, true, "the first text-delta arrived only after the CLI exited")
      assert.deepEqual(
        parts.map((part) => part.type),
        [
          "stream-start",
          "reasoning-start",
          "reasoning-delta",
          "reasoning-end",
          "text-start",
          "text-delta",
          "text-delta",
          "text-end",
          "finish",
        ],
      )
      const text = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
      assert.equal(text, "ok: Auto")
      const finish = parts[parts.length - 1]!
      assert.equal(finish.finishReason.unified, "stop")
      assert.equal(finish.usage.inputTokens.total, 50_000)
      const metadata = finish.providerMetadata.qoder as Record<string, unknown>
      assert.equal(metadata.contextUsageRatio, 0.5)
      assert.equal(metadata.approximatedContextTokens, true)
    },
  )
})

test("doStream fails when the CLI stream never produces a result event", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "partial-no-result" }, async () => {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

    assert.equal(parts[parts.length - 1]!.type, "error")
    assert.match(String(parts[parts.length - 1]!.error.message), /without a result event/)
    assert.equal(parts.some((part) => part.type === "finish"), false)

    const logged = readLogged(logFile)
    assert.equal(logged.length, 1)
    assert.equal(logged[0]!.isError, true)
  })
})

test("doStream with an empty text block that never stops closes it once and reuses no id", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "partial-empty", FAKE_QODER_EMPTY_STOP: "0", FAKE_QODER_RESULT_TEXT: "" }, async () => {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

    // The still-open empty parser block is closed first, then the fallback
    // text block uses a brand new id: no id is ever started twice.
    assert.deepEqual(
      parts.map((part) => `${part.type}:${part.id ?? ""}`),
      [
        "stream-start:",
        "text-start:qoder-text-0",
        "text-end:qoder-text-0",
        "text-start:qoder-text-fallback",
        "text-end:qoder-text-fallback",
        "finish:",
      ],
    )
    const text = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
    assert.equal(text, "")
  })
})

test("doStream with an empty stopped text block emits the fallback block with a unique id", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "partial-empty", FAKE_QODER_RESULT_TEXT: "" }, async () => {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

    assert.deepEqual(
      parts.map((part) => `${part.type}:${part.id ?? ""}`),
      [
        "stream-start:",
        "text-start:qoder-text-0",
        "text-end:qoder-text-0",
        "text-start:qoder-text-fallback",
        "text-end:qoder-text-fallback",
        "finish:",
      ],
    )
  })
})

test("doStream with an empty text block and non-empty result.text streams it as the fallback block", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  await withFakeEnv({ FAKE_QODER_MODE: "partial-empty", FAKE_QODER_RESULT_TEXT: "the real answer" }, async () => {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

    assert.deepEqual(
      parts.map((part) => `${part.type}:${part.id ?? ""}`),
      [
        "stream-start:",
        "text-start:qoder-text-0",
        "text-end:qoder-text-0",
        "text-start:qoder-text-fallback",
        "text-delta:qoder-text-fallback",
        "text-end:qoder-text-fallback",
        "finish:",
      ],
    )
    const delta = parts.find((part) => part.type === "text-delta")!
    assert.equal(delta.delta, "the real answer")
    const finish = parts[parts.length - 1]!
    assert.equal(finish.finishReason.unified, "stop")
  })
})

test("every text block id in a doStream run starts and ends at most once", async () => {
  // Structural guard against duplicate block sequences across all modes.
  for (const env of [
    { FAKE_QODER_MODE: "partial-empty", FAKE_QODER_EMPTY_STOP: "0" },
    { FAKE_QODER_MODE: "partial-empty" },
    { FAKE_QODER_MODE: "partial-empty", FAKE_QODER_RESULT_TEXT: "late text" },
  ]) {
    const { provider } = makeProvider()
    const model = provider.languageModel("Auto")
    await withFakeEnv(env, async () => {
      const { stream } = await model.doStream({ prompt: PROMPT })
      const parts: any[] = []
      for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)
      const starts = new Map<string, number>()
      const ends = new Map<string, number>()
      for (const part of parts) {
        if (part.type === "text-start" || part.type === "reasoning-start") {
          starts.set(part.id, (starts.get(part.id) ?? 0) + 1)
        }
        if (part.type === "text-end" || part.type === "reasoning-end") {
          ends.set(part.id, (ends.get(part.id) ?? 0) + 1)
        }
      }
      for (const [id, count] of starts) assert.equal(count, 1, `block id ${id} started ${count} times`)
      for (const [id, count] of ends) assert.equal(count, 1, `block id ${id} ended ${count} times`)
      assert.deepEqual([...ends.keys()].sort(), [...starts.keys()].sort())
    })
  }
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

test("doStream forwards a positive integer maxOutputTokens to --max-output-tokens", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_MODE: "partial", FAKE_QODER_RECORD: record }, async () => {
    const { stream } = await model.doStream({ prompt: PROMPT, maxOutputTokens: 2048 })
    for await (const _ of stream as unknown as AsyncIterable<any>) {
      // drain
    }
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv[argv.indexOf("--max-output-tokens") + 1], "2048")
    assert.equal(argv[argv.indexOf("-o") + 1], "stream-json")
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
