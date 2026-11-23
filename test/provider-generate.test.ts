import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { DEFAULT_PERMISSION_MODE, MAX_PROMPT_BYTES } from "../src/options.mjs"
import { ModelFallbackError } from "../src/result.mjs"
import { readReasoningEffort } from "../src/provider.mjs"
import { OUTPUT_CONSTRAINT } from "../src/prompt.mjs"
import { makeProvider, tempDir, withFakeEnv, PROMPT } from "./provider-test-helpers.ts"

/** 与 test/fixtures/fake-qoder.mjs 的 `bridge` 模式保持一致。 */
const BRIDGE_TEXT = [
  "Let me check.",
  '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call><tool_call>{"name":"read","arguments":{"filePath":"a.txt"}}</tool_call>',
  "Done.",
].join("\n")

const BRIDGE_TOOLS = [
  {
    type: "function",
    name: "bash",
    description: "Run a shell command",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    type: "function",
    name: "read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
  },
  { type: "provider", name: "web_search", id: "web_search" },
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

test("doGenerate forwards image parts to the CLI as --attachment temp files", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  await withFakeEnv({ FAKE_QODER_RECORD: record }, async () => {
    const result = await model.doGenerate({
      prompt: [
        { role: "system", content: "be brief" },
        {
          role: "user",
          content: [
            { type: "text", text: "what is in the image?" },
            { type: "image", image: png, mediaType: "image/png" },
          ],
        },
      ],
    })
    assert.equal((result.content[0] as { text: string }).text, "ok: Auto")

    const recorded = JSON.parse(readFileSync(record, "utf8"))
    assert.equal(recorded.stdin.includes("what is in the image?"), true)
    assert.equal(recorded.attachments.length, 1)
    assert.match(recorded.attachments[0].path, /attachment-0\.png$/)
    assert.equal(recorded.attachments[0].base64, Buffer.from(png).toString("base64"))
    assert.equal(existsSync(recorded.attachments[0].path), false)
  })
})

test("doGenerate still rejects non-image file parts", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  await assert.rejects(
    model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "file", data: "AAAA", mediaType: "application/pdf" },
          ],
        },
      ],
    }),
    /text and image input only/,
  )
})

test("doGenerate bridges host function tools through the text protocol", async () => {
  const { provider, dir, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")

  await withFakeEnv({ FAKE_QODER_MODE: "bridge", FAKE_QODER_RECORD: record }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT, tools: BRIDGE_TOOLS })

    assert.deepEqual(result.content.map((part: { type: string }) => part.type), ["text", "tool-call", "tool-call"])
    assert.equal(result.content[0]!.text, "Let me check.\n\nDone.")
    assert.equal(result.content[1]!.toolName, "bash")
    assert.equal(result.content[1]!.input, '{"command":"ls"}')
    assert.equal(result.content[2]!.toolName, "read")
    assert.equal(result.content[2]!.input, '{"filePath":"a.txt"}')
    assert.match(result.content[1]!.toolCallId, /^qoder-bridge-[0-9a-z]+-0$/)
    assert.match(result.content[2]!.toolCallId, /^qoder-bridge-[0-9a-z]+-1$/)
    assert.notEqual(result.content[1]!.toolCallId, result.content[2]!.toolCallId)
    assert.deepEqual(result.finishReason, { unified: "tool-calls", raw: "end_turn" })

    // provider 工具无法经文本协议执行：跳过并记 warning。
    assert.equal(result.warnings.length, 1)
    assert.equal(result.warnings[0]!.type, "other")
    assert.match(result.warnings[0]!.message, /web_search/)

    const recorded = JSON.parse(readFileSync(record, "utf8"))
    const argv: string[] = recorded.argv
    // 宿主 system 消息落成 --append-system-prompt-file 临时文件，不再混进 stdin 的用户文本。
    assert.equal(argv.includes("--append-system-prompt"), false)
    const appended = recorded.systemPrompt.content as string
    assert.match(appended, /^be brief\n\n/)
    assert.match(appended, /<tool_call>\{"name": "<tool name>", "arguments": \{\.\.\.\}\}<\/tool_call>/)
    assert.match(appended, /- bash: Run a shell command/)
    assert.match(appended, /- read: Read a file/)
    assert.equal(recorded.stdin.includes("be brief"), false)
    assert.equal(recorded.stdin.includes("[user]\nhello"), true)
    assert.equal(argv.includes("--strict-mcp-config"), true)
    // --tools 是变长参数，必须留在最后且被强制清空。
    assert.deepEqual(argv.slice(argv.indexOf("--tools")), ["--tools", ""])

    const logged = JSON.parse(readFileSync(logFile, "utf8").trim())
    assert.equal(logged.bridge, true)
    assert.equal(logged.toolCalls, 2)
  })
})

test("doGenerate keeps the old behaviour when toolBridge is disabled", async () => {
  const { provider, dir } = makeProvider({ toolBridge: false })
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")

  await withFakeEnv({ FAKE_QODER_MODE: "bridge", FAKE_QODER_RECORD: record }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT, tools: BRIDGE_TOOLS })

    // 信封原样留在正文里，不产生 tool-call part。
    assert.deepEqual(result.content.map((part: { type: string }) => part.type), ["text"])
    assert.equal(result.content[0]!.text, BRIDGE_TEXT)
    assert.deepEqual(result.finishReason, { unified: "stop", raw: "end_turn" })
    assert.deepEqual(result.warnings, [])

    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv.includes("--strict-mcp-config"), false)
    assert.equal(argv.includes("--tools"), false)
    // system 仍然单独走 --append-system-prompt-file，但不含工具协议。
    const recordedFull = JSON.parse(readFileSync(record, "utf8"))
    assert.equal(recordedFull.systemPrompt.content, "be brief")
  })
})

test("doGenerate skips the bridge when the host passes no function tools", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")

  await withFakeEnv({ FAKE_QODER_MODE: "bridge", FAKE_QODER_RECORD: record }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT, tools: [{ type: "provider", name: "web_search" }] })
    assert.deepEqual(result.content.map((part: { type: string }) => part.type), ["text"])
    assert.equal(result.content[0]!.text, BRIDGE_TEXT)
    assert.deepEqual(result.warnings, [])

    const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
    assert.equal(argv.includes("--strict-mcp-config"), false)
    assert.equal(argv.includes("--tools"), false)
  })
})

test("doGenerate with no tool calls in the bridged reply keeps the plain result", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const result = await model.doGenerate({ prompt: PROMPT, tools: [BRIDGE_TOOLS[0]!] })
  assert.deepEqual(result.content.map((part: { type: string }) => part.type), ["text"])
  assert.equal(result.content[0]!.text, "ok: Auto")
  assert.deepEqual(result.finishReason, { unified: "stop", raw: "end_turn" })
})

test("doGenerate translates a native tool call and drops the CLI error text", async () => {
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
  await withFakeEnv({ FAKE_QODER_MODE: "native-tool", FAKE_QODER_RESULT_TEXT: "The native call failed." }, async () => {
    const result = await model.doGenerate({ prompt: PROMPT, tools })
    assert.deepEqual(result.content.map((part: { type: string }) => part.type), ["tool-call"])
    assert.equal(result.content[0]!.toolName, "get_weather")
    assert.equal(result.content[0]!.input, '{"city":"Hangzhou"}')
    assert.deepEqual(result.finishReason, { unified: "tool-calls", raw: "end_turn" })
  })
})

for (const variant of ["qodercn", "qoder"] as const) {
  test(`the ${variant} variant bridges tools with the same argv and content contract`, async () => {
    const { provider, dir } = makeProvider({ variant })
    assert.equal(provider.provider, variant)
    const model = provider.languageModel("Auto")
    const record = join(dir, "record.json")

    await withFakeEnv({ FAKE_QODER_MODE: "bridge", FAKE_QODER_RECORD: record }, async () => {
      const result = await model.doGenerate({ prompt: PROMPT, tools: BRIDGE_TOOLS, toolChoice: { type: "required" } })
      assert.deepEqual(result.content.map((part: { type: string }) => part.type), ["text", "tool-call", "tool-call"])
      assert.deepEqual(result.finishReason, { unified: "tool-calls", raw: "end_turn" })

      const recordedReply = JSON.parse(readFileSync(record, "utf8"))
      const argv = recordedReply.argv as string[]
      assert.equal(argv.includes("--strict-mcp-config"), true)
      assert.deepEqual(argv.slice(argv.indexOf("--tools")), ["--tools", ""])
      assert.equal(argv.includes("--append-system-prompt"), false)
      assert.match(recordedReply.systemPrompt.content, /must call at least one tool/)
    })
  })
}

test("readReasoningEffort reads the provider-scoped option first, then top-level, then call options", () => {
  assert.equal(
    readReasoningEffort(
      { providerOptions: { qodercn: { reasoningEffort: "high" }, reasoningEffort: "low" }, reasoningEffort: "medium" },
      "qodercn",
    ),
    "high",
  )
  assert.equal(readReasoningEffort({ providerOptions: { reasoningEffort: "low" }, reasoningEffort: "medium" }, "qodercn"), "low")
  assert.equal(readReasoningEffort({ reasoningEffort: "medium" }, "qodercn"), "medium")
  // 其他 provider 的键不参与读取。
  assert.equal(readReasoningEffort({ providerOptions: { other: { reasoningEffort: "high" } } }, "qodercn"), undefined)
  // 高优先级层给的是非法值时继续看下一层。
  assert.equal(
    readReasoningEffort({ providerOptions: { qodercn: { reasoningEffort: "bogus" } }, reasoningEffort: "high" }, "qodercn"),
    "high",
  )
  for (const value of ["bogus", "", 5, null, undefined]) {
    assert.equal(readReasoningEffort({ reasoningEffort: value }, "qodercn"), undefined)
  }
  assert.equal(readReasoningEffort(undefined, "qodercn"), undefined)
})

test("doGenerate forwards the reasoning effort and the visible output constraint to the CLI", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_RECORD: record }, async () => {
    await model.doGenerate({ prompt: PROMPT, providerOptions: { qodercn: { reasoningEffort: "xhigh" } } })
  })
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  const argv = recorded.argv as string[]
  assert.equal(argv[argv.indexOf("--reasoning-effort") + 1], "xhigh")
  assert.equal(argv.includes("--append-system-prompt"), false)
  const system = recorded.systemPrompt.content as string
  assert.ok(system.startsWith("be brief\n\n# Visible output constraints"))
  assert.ok(system.includes(OUTPUT_CONSTRAINT))
})

test("doGenerate sends no --reasoning-effort for auto or unknown values", async () => {
  const { provider, dir } = makeProvider()
  const model = provider.languageModel("Auto")
  const record = join(dir, "record.json")
  await withFakeEnv({ FAKE_QODER_RECORD: record }, async () => {
    await model.doGenerate({ prompt: PROMPT, providerOptions: { qodercn: { reasoningEffort: "auto" } } })
  })
  const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv
  assert.equal(argv.includes("--reasoning-effort"), false)
})
