import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { OUTPUT_CONSTRAINT } from "../src/prompt.mjs"
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

test("doStream translates a native mcp_call into a host tool call and hides the CLI error text", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const tools = [
    {
      type: "function",
      name: "get_weather",
      description: "Return the current weather for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  ]

  await withFakeEnv(
    { FAKE_QODER_MODE: "native-tool", FAKE_QODER_RESULT_TEXT: "The native call failed." },
    async () => {
      const { stream } = await model.doStream({ prompt: PROMPT, tools })
      const parts: any[] = []
      for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

      // 原生 tool_use 之后 CLI 的错误自愈正文不能泄漏给宿主。
      assert.equal(parts.some((part) => part.type === "text-delta"), false)
      const call = parts.find((part) => part.type === "tool-call")
      assert.equal(call.toolName, "get_weather")
      assert.equal(call.input, '{"city":"Hangzhou"}')
      assert.deepEqual(parts[parts.length - 1]!.finishReason, { unified: "tool-calls", raw: "end_turn" })

      const logged = readLogged(logFile)
      assert.equal(logged[0]!.bridge, true)
      assert.equal(logged[0]!.toolCalls, 1)
    },
  )
})

test("doStream ignores native tools that are not host tools", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const tools = [
    {
      type: "function",
      name: "get_weather",
      description: "Return the current weather for a city",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ]

  await withFakeEnv(
    {
      FAKE_QODER_MODE: "native-tool",
      FAKE_QODER_NATIVE_NAME: "mcp_list",
      FAKE_QODER_NATIVE_INPUT: '{"keyword":"weather"}',
      FAKE_QODER_RESULT_TEXT: "The native call failed.",
    },
    async () => {
      const { stream } = await model.doStream({ prompt: PROMPT, tools })
      const parts: any[] = []
      for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

      assert.equal(parts.some((part) => part.type === "tool-call"), false)
      const text = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
      assert.equal(text, "The native call failed.")
      assert.deepEqual(parts[parts.length - 1]!.finishReason, { unified: "stop", raw: "end_turn" })
    },
  )
})

test("doStream bridges host function tools: split envelopes become tool-call parts", async () => {
  const { provider, dir, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  const tools = [
    {
      type: "function",
      name: "bash",
      description: "Run a shell command",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
    { type: "provider", name: "web_search", id: "web_search" },
  ]

  await withFakeEnv(
    {
      FAKE_QODER_MODE: "bridge-stream",
      FAKE_QODER_RECORD: record,
      // 真实 CLI 的 result.result 会重复最终回答；日志用它统计信封条数。
      FAKE_QODER_RESULT_TEXT: 'Before <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call> after',
    },
    async () => {
    const { stream } = await model.doStream({ prompt: PROMPT, tools })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)

    assert.deepEqual(
      parts.map((part) => `${part.type}:${part.id ?? ""}`),
      [
        "stream-start:",
        "text-start:qoder-text-bridge",
        "text-delta:qoder-text-bridge",
        "text-delta:qoder-text-bridge",
        "text-end:qoder-text-bridge",
        "tool-input-start:" + parts[5]!.id,
        "tool-input-delta:" + parts[5]!.id,
        "tool-input-end:" + parts[5]!.id,
        "tool-call:",
        "finish:",
      ],
    )
    const text = parts.filter((part) => part.type === "text-delta").map((part) => part.delta).join("")
    assert.equal(text, "Before  after")
    assert.match(parts[5]!.id, /^qoder-bridge-[0-9a-z]+-0$/)
    assert.equal(parts[5]!.toolName, "bash")
    assert.equal(parts[6]!.delta, '{"command":"ls"}')
    const call = parts[8]!
    assert.equal(call.toolName, "bash")
    assert.equal(call.input, '{"command":"ls"}')
    assert.deepEqual(parts[9]!.finishReason, { unified: "tool-calls", raw: "end_turn" })
    // provider 工具无法经文本协议执行：只记 warning，不进协议。
    assert.equal(parts[0]!.warnings.length, 1)
    assert.match(parts[0]!.warnings[0].message, /web_search/)

    const recorded = JSON.parse(readFileSync(record, "utf8"))
    const argv: string[] = recorded.argv
    assert.equal(argv.includes("--strict-mcp-config"), true)
    assert.deepEqual(argv.slice(argv.indexOf("--tools")), ["--tools", ""])
    assert.match(argv[argv.indexOf("--append-system-prompt") + 1]!, /- bash: Run a shell command/)

    const logged = readLogged(logFile)
    assert.equal(logged[0]!.bridge, true)
    assert.equal(logged[0]!.toolCalls, 1)
    },
  )
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

test("doStream forwards image parts to the CLI as --attachment temp files", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")

  await withFakeEnv({ FAKE_QODER_MODE: "partial", FAKE_QODER_RECORD: record }, async () => {
    const { stream } = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "file", data: jpeg, mediaType: "image/jpeg" },
          ],
        },
      ],
    })
    for await (const _ of stream as unknown as AsyncIterable<any>) {
      // 排空
    }
    const recorded = JSON.parse(readFileSync(record, "utf8"))
    assert.equal(recorded.attachments.length, 1)
    assert.match(recorded.attachments[0].path, /attachment-0\.jpg$/)
    assert.equal(recorded.attachments[0].base64, jpeg)
  })
})

test("doStream appends OUTPUT_CONSTRAINT before the tool protocol and forwards the reasoning effort", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  const tools = [
    {
      type: "function",
      name: "bash",
      description: "Run a shell command",
      inputSchema: { type: "object", properties: {} },
    },
  ]
  await withFakeEnv({ FAKE_QODER_MODE: "bridge-stream", FAKE_QODER_RECORD: record }, async () => {
    const { stream } = await model.doStream({
      prompt: PROMPT,
      tools,
      providerOptions: { qodercn: { reasoningEffort: "medium" } },
    })
    for await (const _ of stream as unknown as AsyncIterable<any>) {
      // 排空
    }
  })
  const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
  const system = argv[argv.indexOf("--append-system-prompt") + 1]!
  assert.ok(system.startsWith("be brief\n\n"))
  assert.ok(system.includes(OUTPUT_CONSTRAINT))
  const constraintIndex = system.indexOf("# Visible output constraints")
  const protocolIndex = system.indexOf("- bash: Run a shell command")
  assert.ok(constraintIndex > 0, "OUTPUT_CONSTRAINT must be appended")
  assert.ok(protocolIndex > constraintIndex, "tool protocol must follow OUTPUT_CONSTRAINT")
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "medium")
})

test("doStream reads reasoningEffort from the nested settings shape of providerOptions", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_MODE: "bridge-stream", FAKE_QODER_RECORD: record }, async () => {
    const { stream } = await model.doStream({
      prompt: PROMPT,
      providerOptions: { qodercn: { settings: { reasoningEffort: "xhigh" } } },
    })
    for await (const _ of stream as unknown as AsyncIterable<any>) {
      // 排空
    }
  })
  const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "xhigh")
})
