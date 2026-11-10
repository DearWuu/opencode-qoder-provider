import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ModelFallbackError } from "../src/result.mjs"
import { makeProvider, readLogged, withFakeEnv, PROMPT } from "./provider-test-helpers.ts"

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
          // delta 必须在 CLI 仍在运行时到达（真增量，
          // 而不是缓冲输出的事后重放）。
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

    // 仍处于打开状态的空解析块先被关闭，随后回退文本块
    // 使用全新 id：任何 id 都不会 start 两次。
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
  // 结构性防护：任何模式下块序列都不得重复。
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

test("doStream forwards a positive integer maxOutputTokens to --max-output-tokens", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_MODE: "partial", FAKE_QODER_RECORD: record }, async () => {
    const { stream } = await model.doStream({ prompt: PROMPT, maxOutputTokens: 2048 })
    for await (const _ of stream as unknown as AsyncIterable<any>) {
      // 排空
    }
    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv[argv.indexOf("--max-output-tokens") + 1], "2048")
    assert.equal(argv[argv.indexOf("-o") + 1], "stream-json")
  })
})
