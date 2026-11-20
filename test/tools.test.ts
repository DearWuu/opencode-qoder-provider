import { test } from "node:test"
import assert from "node:assert/strict"

import {
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
  createToolCallScanner,
  extractToolCalls,
  functionTools,
  renderToolProtocol,
} from "../src/tools.mjs"

const BASH = {
  type: "function",
  name: "bash",
  description: "Run a shell command",
  inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
}

const READ = {
  type: "function",
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
}

const PROVIDER_TOOL = { type: "provider", name: "web_search", id: "web_search" }

function envelope(name: string, args: unknown): string {
  return `${TOOL_CALL_OPEN}${JSON.stringify({ name, arguments: args })}${TOOL_CALL_CLOSE}`
}

test("functionTools keeps function tools and reports skipped provider tools", () => {
  const { tools, skipped } = functionTools([BASH, PROVIDER_TOOL, READ, { type: "function" }, null])
  assert.deepEqual(tools.map((tool) => tool.name), ["bash", "read"])
  assert.deepEqual(skipped, ["web_search", "(unnamed provider tool)"])
  assert.deepEqual(functionTools(undefined), { tools: [], skipped: [] })
  assert.deepEqual(functionTools([] as never), { tools: [], skipped: [] })
})

test("renderToolProtocol lists every tool with its schema and the envelope shape", () => {
  const protocol = renderToolProtocol([BASH, READ], undefined)
  assert.match(protocol, /- bash: Run a shell command/)
  assert.match(protocol, /"command":\{"type":"string"\}/)
  assert.match(protocol, /- read: Read a file/)
  assert.match(protocol, /<tool_call>\{"name": "<tool name>", "arguments": \{\.\.\.\}\}<\/tool_call>/)
  assert.match(protocol, /Do not wrap tool calls in Markdown code fences/)
})

test("renderToolProtocol 允许无工具回答及调用前的简短进度", () => {
  for (const tools of [[], [BASH]]) {
    const protocol = renderToolProtocol(tools, { type: "auto" })
    assert.match(protocol, /You may answer normally without calling a tool when no tool is needed, unless this turn explicitly requires a tool/)
    assert.match(protocol, /Brief progress updates are allowed before tool calls/)
    assert.match(protocol, /When a tool is needed, emit one or more tool-call envelopes/)
    assert.doesNotMatch(protocol, /Reply with one or more tool calls and nothing else/)
  }
})

test("renderToolProtocol 要求合法信封、等待真实结果且禁止假回执", () => {
  const protocol = renderToolProtocol([BASH], undefined)
  assert.match(protocol, /"name" must be one of the tool names listed above/)
  assert.match(protocol, /"arguments" must be a JSON object that satisfies that tool's input schema/)
  assert.match(protocol, /After emitting the tool calls, stop and wait/)
  assert.match(protocol, /Never invent, guess or write a tool result\n  yourself, and never describe a result you did not receive/)
  assert.match(protocol, /Do not simulate host acknowledgements or tool receipts/)
})

test("工具解析器不按正文中的 reasoning 或回执标记过滤文本", () => {
  const text = "  分析报告\n[reasoning]\n[tool-result] 引用\n```text\n[assistant]\n```\n"
  assert.deepEqual(extractToolCalls(text), { text, calls: [] })
  const visible: string[] = []
  const scanner = createToolCallScanner({ onText: (chunk) => visible.push(chunk) })
  for (const character of text) scanner.push(character)
  assert.deepEqual(scanner.finish(), { calls: [] })
  assert.equal(visible.join(""), text)
})

test("renderToolProtocol honours toolChoice required and tool", () => {
  assert.match(renderToolProtocol([BASH], { type: "required" }), /This turn you must call at least one tool\./)
  assert.match(renderToolProtocol([BASH], { type: "tool", toolName: "bash" }), /This turn you must call the tool "bash"\./)
  const auto = renderToolProtocol([BASH], { type: "auto" })
  assert.equal(auto.includes("This turn you must call"), false)
})

test("renderToolProtocol marks an empty tool list instead of inventing tools", () => {
  const protocol = renderToolProtocol([], undefined)
  assert.match(protocol, /\(no tools are available this turn\)/)
})

test("extractToolCalls parses multiple envelopes and keeps the surrounding text", () => {
  const text = `before\n${envelope("bash", { command: "ls" })}\nmiddle\n${envelope("read", { filePath: "a.txt" })}\nafter`
  const parsed = extractToolCalls(text)
  assert.deepEqual(parsed.calls, [
    { toolName: "bash", arguments: '{"command":"ls"}' },
    { toolName: "read", arguments: '{"filePath":"a.txt"}' },
  ])
  assert.equal(parsed.text, "before\n\nmiddle\n\nafter")
})

test("extractToolCalls keeps invalid envelopes, unclosed envelopes and nameless envelopes as text", () => {
  const invalidJson = `${TOOL_CALL_OPEN}{not json}${TOOL_CALL_CLOSE}`
  const unclosed = `${TOOL_CALL_OPEN}{"name":"bash","arguments":{}}`
  const nameless = `${TOOL_CALL_OPEN}{"arguments":{}}${TOOL_CALL_CLOSE}`
  const parsed = extractToolCalls(`a${invalidJson}b${unclosed}c${nameless}`)
  assert.deepEqual(parsed.calls, [])
  assert.equal(parsed.text, `a${invalidJson}b${unclosed}c${nameless}`)
})

test("extractToolCalls normalizes non-object arguments", () => {
  assert.deepEqual(extractToolCalls(envelope("bash", "ls -la")).calls, [{ toolName: "bash", arguments: "ls -la" }])
  assert.deepEqual(extractToolCalls(envelope("bash", 42)).calls, [{ toolName: "bash", arguments: "42" }])
  assert.deepEqual(extractToolCalls(envelope("bash", undefined)).calls, [{ toolName: "bash", arguments: "{}" }])
  assert.deepEqual(extractToolCalls(envelope("bash", ["a"])).calls, [{ toolName: "bash", arguments: '["a"]' }])
})

test("extractToolCalls trims the tool name and tolerates surrounding whitespace", () => {
  const block = `${TOOL_CALL_OPEN}  {"name":" bash ","arguments":{}}  ${TOOL_CALL_CLOSE}`
  assert.deepEqual(extractToolCalls(block).calls, [{ toolName: "bash", arguments: "{}" }])
})

test("createToolCallScanner reassembles an envelope split across deltas", () => {
  const visible: string[] = []
  const scanner = createToolCallScanner({ onText: (chunk) => visible.push(chunk) })
  const call = envelope("bash", { command: "ls" })
  for (let index = 0; index < call.length; index += 3) {
    scanner.push(call.slice(index, index + 3))
  }
  assert.deepEqual(scanner.finish().calls, [{ toolName: "bash", arguments: '{"command":"ls"}' }])
  assert.equal(visible.join(""), "")
})

test("createToolCallScanner emits text before and after an envelope", () => {
  const visible: string[] = []
  const scanner = createToolCallScanner({ onText: (chunk) => visible.push(chunk) })
  const chunks = ["Before ", `${TOOL_CALL_OPEN}{"name":"ba`, 'sh","arguments":{"command":"ls"}}', `${TOOL_CALL_CLOSE}`, " after"]
  for (const chunk of chunks) scanner.push(chunk)
  scanner.finish()
  assert.equal(visible.join(""), "Before  after")
  assert.deepEqual(scanner.calls, [{ toolName: "bash", arguments: '{"command":"ls"}' }])
})

test("createToolCallScanner flushes an unclosed envelope or invalid JSON as text on finish", () => {
  const visible: string[] = []
  const scanner = createToolCallScanner({ onText: (chunk) => visible.push(chunk) })
  scanner.push(`${TOOL_CALL_OPEN}{"name":"bash"`)
  assert.equal(visible.join(""), "")
  const finished = scanner.finish()
  assert.deepEqual(finished.calls, [])
  assert.equal(visible.join(""), `${TOOL_CALL_OPEN}{"name":"bash"`)

  const invalidVisible: string[] = []
  const invalidScanner = createToolCallScanner({ onText: (chunk) => invalidVisible.push(chunk) })
  invalidScanner.push(`${TOOL_CALL_OPEN}{oops}${TOOL_CALL_CLOSE}`)
  invalidScanner.finish()
  assert.equal(invalidVisible.join(""), `${TOOL_CALL_OPEN}{oops}${TOOL_CALL_CLOSE}`)
})

test("createToolCallScanner holds back only a plausible open-tag prefix", () => {
  const visible: string[] = []
  const scanner = createToolCallScanner({ onText: (chunk) => visible.push(chunk) })
  scanner.push("hello <tool")
  assert.equal(visible.join(""), "hello ")
  scanner.push("_call>{\"name\":\"bash\",\"arguments\":{}}</tool_call>tail")
  scanner.finish()
  assert.equal(visible.join(""), "hello tail")
  assert.deepEqual(scanner.calls, [{ toolName: "bash", arguments: "{}" }])
})

test("createToolCallScanner supports several calls in one stream", () => {
  const visible: string[] = []
  const scanner = createToolCallScanner({ onText: (chunk) => visible.push(chunk) })
  scanner.push(`${envelope("bash", { command: "ls" })}${envelope("read", { filePath: "a" })}`)
  const finished = scanner.finish()
  assert.deepEqual(finished.calls, [
    { toolName: "bash", arguments: '{"command":"ls"}' },
    { toolName: "read", arguments: '{"filePath":"a"}' },
  ])
  assert.equal(visible.join(""), "")
})
