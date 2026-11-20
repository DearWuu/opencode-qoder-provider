import { test } from "node:test"
import assert from "node:assert/strict"

import { assertPromptSize, OUTPUT_CONSTRAINT, PromptTooLargeError, promptByteLength, serializePrompt, UnsupportedMediaError } from "../src/prompt.mjs"
import { CLI_STDIN_LIMIT_BYTES, MAX_PROMPT_BYTES } from "../src/options.mjs"

test("serializePrompt extracts system messages and flattens the remaining roles", () => {
  const { text, system, attachments } = serializePrompt([
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "text", value: "file.txt" } }],
    },
  ])

  // system 内容单独返回，不混进用户文本。
  assert.equal(system, "You are a helpful assistant.")
  assert.equal(text.includes("[system]"), false)
  assert.equal(text.includes("You are a helpful assistant."), false)
  assert.match(text, /\[user\]\nhello/)
  assert.match(text, /\[assistant\]\nthinking out loud/)
  // 历史里的 tool-call 按桥接协议信封回放。
  assert.match(text, /<tool_call>\{"name":"bash","arguments":\{"command":"ls"\}\}<\/tool_call>/)
  assert.match(text, /\[tool-result\] bash \(call-1\)\nfile\.txt/)
  assert.ok(text.indexOf("[user]") < text.indexOf("[assistant]"))
  assert.ok(text.indexOf("[assistant]") < text.indexOf("[tool]"))
  assert.deepEqual(attachments, [])
})

test("serializePrompt joins multiple system messages and omits the key when there are none", () => {
  const { system } = serializePrompt([
    { role: "system", content: "first" },
    { role: "system", content: "second" },
    { role: "user", content: "hi" },
  ])
  assert.equal(system, "first\n\nsecond")

  const noSystem = serializePrompt([{ role: "user", content: "hi" }])
  assert.equal(noSystem.system, "")
  assert.equal(noSystem.text, "[user]\nhi")
})

test("serializePrompt collects image parts and image/* file parts as ordered attachments", () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const { text, attachments } = serializePrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "what is in these pictures?" },
        { type: "image", image: bytes, mediaType: "image/png" },
        { type: "file", data: "AAAA", mediaType: "image/jpeg" },
      ],
    },
  ])

  assert.match(text, /what is in these pictures\?/)
  assert.equal(attachments.length, 2)
  assert.deepEqual(attachments[0], { mediaType: "image/png", data: bytes })
  assert.deepEqual(attachments[1], { mediaType: "image/jpeg", data: "AAAA" })
})

test("serializePrompt keeps image parts without a mediaType", () => {
  const { attachments } = serializePrompt([{ role: "user", content: [{ type: "image", image: "AAAA" }] }])
  assert.deepEqual(attachments, [{ mediaType: undefined, data: "AAAA" }])
})

test("serializePrompt rejects non-image file parts", () => {
  assert.throws(
    () =>
      serializePrompt([
        {
          role: "user",
          content: [{ type: "file", mediaType: "application/pdf", data: "AAAA" }],
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedMediaError)
      assert.match((error as Error).message, /text and image input only/)
      assert.match((error as Error).message, /application\/pdf/)
      return true
    },
  )
})

test("serializePrompt rejects image payloads that are neither base64 nor Uint8Array", () => {
  assert.throws(
    () =>
      serializePrompt([
        { role: "user", content: [{ type: "image", image: new URL("https://example.com/a.png"), mediaType: "image/png" }] },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedMediaError)
      assert.match((error as Error).message, /remote URLs are not supported/)
      return true
    },
  )
  assert.throws(
    () => serializePrompt([{ role: "user", content: [{ type: "image", image: "not base64!", mediaType: "image/png" }] }]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedMediaError)
      assert.match((error as Error).message, /base64 data or Uint8Array/)
      return true
    },
  )
})

test("serializePrompt rejects an unknown prompt role", () => {
  assert.throws(() => serializePrompt([{ role: "developer", content: "x" } as never]), /does not support the prompt role/)
})

test("assertPromptSize rejects prompts above the safe limit", () => {
  const oversized = "x".repeat(MAX_PROMPT_BYTES + 1)
  assert.throws(
    () => assertPromptSize(oversized),
    (error: unknown) => {
      assert.ok(error instanceof PromptTooLargeError)
      assert.match((error as Error).message, /exceeds the 7340032 byte limit/)
      assert.match((error as Error).message, new RegExp(String(CLI_STDIN_LIMIT_BYTES)))
      return true
    },
  )
})

test("assertPromptSize accepts prompts below the safe limit", () => {
  const ok = "x".repeat(1024)
  assert.equal(assertPromptSize(ok), promptByteLength(ok))
})

test("the safe limit stays below the CLI hard limit", () => {
  assert.ok(MAX_PROMPT_BYTES < CLI_STDIN_LIMIT_BYTES)
})

test("serializePrompt drops structured reasoning from assistant turns only", () => {
  const { text } = serializePrompt([
    { role: "assistant", content: [{ type: "reasoning", text: "hidden chain" }, { type: "text", text: "visible answer" }] },
  ])
  assert.equal(text, "[assistant]\nvisible answer")
  assert.equal(text.includes("hidden chain"), false)

  // 只含 reasoning 的 assistant 轮次整体跳过，不留下空的角色块。
  const onlyReasoning = serializePrompt([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "reasoning", text: "thought" }] },
    { role: "user", content: "again" },
  ])
  assert.equal(onlyReasoning.text, "[user]\nhi\n\n[user]\nagain")
})

test("serializePrompt keeps user, tool and quoted content verbatim", () => {
  const quoted = '[reasoning]\n<tool_call>{"name":"bash","arguments":{}}</tool_call>'
  const { text } = serializePrompt([
    { role: "user", content: [{ type: "reasoning", text: "quoted thought" }] },
    { role: "user", content: [{ type: "text", text: quoted }] },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "text", value: quoted } }],
    },
  ])
  assert.match(text, /\[user\]\n\[reasoning\]\nquoted thought/)
  assert.ok(text.includes(`[user]\n${quoted}`))
  assert.ok(text.includes(`[tool-result] bash (call-1)\n${quoted}`))
})
