import { test } from "node:test"
import assert from "node:assert/strict"

import { assertPromptSize, PromptTooLargeError, promptByteLength, serializePrompt, UnsupportedMediaError } from "../src/prompt.mjs"
import { CLI_STDIN_LIMIT_BYTES, MAX_PROMPT_BYTES } from "../src/options.mjs"

test("serializePrompt flattens system, user, assistant and tool messages", () => {
  const text = serializePrompt([
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

  assert.match(text, /\[system\]\nYou are a helpful assistant\./)
  assert.match(text, /\[user\]\nhello/)
  assert.match(text, /\[assistant\]\nthinking out loud/)
  assert.match(text, /\[tool-call\] bash \(call-1\)\n\{"command":"ls"\}/)
  assert.match(text, /\[tool-result\] bash \(call-1\)\nfile\.txt/)
  assert.ok(text.indexOf("[system]") < text.indexOf("[user]"))
  assert.ok(text.indexOf("[user]") < text.indexOf("[assistant]"))
  assert.ok(text.indexOf("[assistant]") < text.indexOf("[tool]"))
})

test("serializePrompt rejects unsupported media parts", () => {
  assert.throws(
    () =>
      serializePrompt([
        {
          role: "user",
          content: [{ type: "file", mediaType: "image/png", data: "AAAA" }],
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof UnsupportedMediaError)
      assert.match((error as Error).message, /text input only/)
      assert.match((error as Error).message, /image\/png/)
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
