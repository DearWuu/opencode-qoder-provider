/**
 * 文件职责：OpenCode 工具桥接的文本协议：渲染宿主工具说明、从回答里解析 `<tool_call>` 信封、流式增量扫描器。
 * 上游：src/provider 的 doGenerate/doStream。
 * 下游：无。
 *
 * 协议只有一个信封形状：
 * `<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>`
 * 信封本身是 JSON；`arguments` 以 JSON 字符串形式交给 AI SDK（LanguageModelV3ToolCall.input）。
 */

/** 工具调用信封的起止标记。 */
export const TOOL_CALL_OPEN = "<tool_call>"
export const TOOL_CALL_CLOSE = "</tool_call>"

/**
 * 从 AI SDK 的工具清单里挑出 function 工具；provider 工具（`type: "provider"`）
 * 无法经文本协议交给宿主执行，单独返回名字供调用方记 warning。
 *
 * @param {Array<any>} [tools]
 * @returns {{ tools: Array<{ type: "function", name: string, description?: string, inputSchema?: any }>, skipped: string[] }}
 */
export function functionTools(tools) {
  const functions = []
  const skipped = []
  if (!Array.isArray(tools)) return { tools: functions, skipped }
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const name = typeof tool.name === "string" ? tool.name.trim() : ""
    if (tool.type === "function" && name.length > 0) {
      functions.push(tool)
    } else {
      skipped.push(name.length > 0 ? name : "(unnamed provider tool)")
    }
  }
  return { tools: functions, skipped }
}

/**
 * 渲染外部宿主工具协议说明，作为 CLI 的 `--append-system-prompt` 传入。
 *
 * @param {Array<{ name: string, description?: string, inputSchema?: any }>} tools
 * @param {{ type?: string, toolName?: string } | undefined} [toolChoice]
 * @returns {string}
 */
export function renderToolProtocol(tools, toolChoice) {
  const list = (Array.isArray(tools) ? tools : []).map((tool) => {
    const name = typeof tool?.name === "string" ? tool.name : "unknown"
    const description = typeof tool?.description === "string" && tool.description.trim().length > 0
      ? tool.description.trim()
      : "(no description)"
    const schema = tool?.inputSchema === undefined ? {} : tool.inputSchema
    return `- ${name}: ${description}\n  input schema: ${safeJson(schema)}`
  })

  const lines = [
    "You are the language model behind an external agent host. The host owns the conversation,",
    "the workspace and every tool. You have no built-in tools of your own: never claim that you",
    "ran a command, read or edited a file, or performed any other action yourself. The only way",
    "to act is to ask the host to run a tool for you.",
    "",
    "# Available host tools",
    list.length > 0 ? list.join("\n") : "- (no tools are available this turn)",
    "",
    "# Replies and tool calls",
    "You may answer normally without calling a tool when no tool is needed, unless this turn explicitly requires a tool.",
    "Brief progress updates are allowed before tool calls; keep internal analysis out of visible text.",
    "When a tool is needed, emit one or more tool-call envelopes. Each tool call is a single block:",
    `<tool_call>{"name": "<tool name>", "arguments": {...}}</tool_call>`,
    '- "name" must be one of the tool names listed above.',
    '- "arguments" must be a JSON object that satisfies that tool\'s input schema.',
    "- Do not wrap tool calls in Markdown code fences.",
    "- You may emit several <tool_call> blocks in one reply; the host runs them in order.",
    "- After emitting the tool calls, stop and wait. The host answers with a [tool-result]",
    "  block that carries the matching call id. Never invent, guess or write a tool result",
    "  yourself, and never describe a result you did not receive.",
    "- Do not simulate host acknowledgements or tool receipts.",
  ]

  if (toolChoice?.type === "required") {
    lines.push("", "- This turn you must call at least one tool.")
  } else if (toolChoice?.type === "tool") {
    const name = typeof toolChoice.toolName === "string" ? toolChoice.toolName : ""
    lines.push("", `- This turn you must call the tool "${name}".`)
  }

  return lines.join("\n")
}

/**
 * 从完整回答文本里解析全部工具调用信封。
 *
 * 信封 JSON 非法、或缺少非空字符串 `name` 时，整块按原文保留在 `text` 里，不产生调用。
 * `arguments` 为对象时序列化为 JSON 字符串，为字符串时原样使用（缺省为 `{}`）。
 *
 * @param {string} text
 * @returns {{ text: string, calls: Array<{ toolName: string, arguments: string }> }}
 */
export function extractToolCalls(text) {
  const source = typeof text === "string" ? text : ""
  const calls = []
  let visible = ""
  let cursor = 0

  while (cursor <= source.length) {
    const open = source.indexOf(TOOL_CALL_OPEN, cursor)
    if (open < 0) {
      visible += source.slice(cursor)
      break
    }
    visible += source.slice(cursor, open)
    const close = source.indexOf(TOOL_CALL_CLOSE, open + TOOL_CALL_OPEN.length)
    if (close < 0) {
      // 未闭合的信封：剩余文本原样保留。
      visible += source.slice(open)
      break
    }
    const block = source.slice(open, close + TOOL_CALL_CLOSE.length)
    const call = parseEnvelope(block)
    if (call) calls.push(call)
    else visible += block
    cursor = close + TOOL_CALL_CLOSE.length
  }

  return { text: visible, calls }
}

/**
 * 流式工具调用扫描器：把 `text_delta` 增量喂进来，只把信封之外的文本经 `onText` 输出，
 * 完整且合法的信封变成调用。
 *
 * 未出现信封时最多扣住 10 个字符（`<tool_call>` 的最长真前缀）再输出；
 * 信封一旦出现就缓冲到 `</tool_call>`，避免跨 delta 切分的信封泄漏到正文。
 *
 * @param {{ onText?: (text: string) => void }} [handlers]
 * @returns {{ push: (delta: string) => void, finish: () => { calls: Array<{ toolName: string, arguments: string }> }, readonly calls: Array<{ toolName: string, arguments: string }> }}
 */
export function createToolCallScanner(handlers = {}) {
  const onText = typeof handlers.onText === "function" ? handlers.onText : undefined
  const calls = []
  let buffer = ""

  const emit = (text) => {
    if (text.length > 0) onText?.(text)
  }

  const drain = () => {
    while (true) {
      const open = buffer.indexOf(TOOL_CALL_OPEN)
      if (open < 0) {
        const hold = pendingPrefixLength(buffer)
        if (buffer.length > hold) {
          emit(buffer.slice(0, buffer.length - hold))
          buffer = buffer.slice(buffer.length - hold)
        }
        return
      }
      if (open > 0) {
        emit(buffer.slice(0, open))
        buffer = buffer.slice(open)
      }
      const close = buffer.indexOf(TOOL_CALL_CLOSE, TOOL_CALL_OPEN.length)
      if (close < 0) return
      const block = buffer.slice(0, close + TOOL_CALL_CLOSE.length)
      buffer = buffer.slice(close + TOOL_CALL_CLOSE.length)
      const call = parseEnvelope(block)
      if (call) calls.push(call)
      else emit(block)
    }
  }

  return {
    push(delta) {
      if (typeof delta !== "string" || delta.length === 0) return
      buffer += delta
      drain()
    },
    finish() {
      emit(buffer)
      buffer = ""
      return { calls: [...calls] }
    },
    get calls() {
      return [...calls]
    },
  }
}

/**
 * 缓冲区末尾可能是 `<tool_call>` 真前缀的最长长度（上限为开标记长度减一，即 10）。
 *
 * @param {string} buffer
 * @returns {number}
 */
function pendingPrefixLength(buffer) {
  const max = Math.min(buffer.length, TOOL_CALL_OPEN.length - 1)
  for (let length = max; length > 0; length--) {
    if (buffer.endsWith(TOOL_CALL_OPEN.slice(0, length))) return length
  }
  return 0
}

/**
 * 把 CLI 原生 `tool_use`（模型绕过文本协议、直接走原生函数调用）翻译成宿主工具调用。
 *
 * 原生事件只接受两种形状：
 * - `name` 是宿主 function 工具名；
 * - `name === "mcp_call"`，参数里的 `toolName` 是 `mcp__<宿主工具名>`（CLI 的 MCP 代理）。
 * 其余原生工具（`mcp_list` 等）返回 undefined，由调用方忽略。
 *
 * @param {string} name 原生工具名。
 * @param {string} inputJson 原生工具的输入 JSON 文本（可能为空串）。
 * @param {Set<string>} hostToolNames 本轮桥接的宿主工具名。
 * @returns {{ toolName: string, arguments: string } | undefined}
 */
export function translateNativeToolCall(name, inputJson, hostToolNames) {
  const toolName = typeof name === "string" ? name : ""
  if (toolName.length === 0 || !(hostToolNames instanceof Set)) return undefined
  let parsed
  try {
    parsed = JSON.parse(typeof inputJson === "string" && inputJson.length > 0 ? inputJson : "{}")
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined

  if (toolName === "mcp_call") {
    const target = typeof parsed.toolName === "string" ? parsed.toolName.replace(/^mcp__/, "") : ""
    if (!hostToolNames.has(target)) return undefined
    return { toolName: target, arguments: renderArguments(parsed.arguments) }
  }
  if (!hostToolNames.has(toolName)) return undefined
  return { toolName, arguments: renderArguments(parsed) }
}

/**
 * 解析单个信封；非法 JSON 或缺少 `name` 时返回 undefined（调用方按原文输出）。
 *
 * @param {string} block
 * @returns {{ toolName: string, arguments: string } | undefined}
 */
function parseEnvelope(block) {
  const inner = block.slice(TOOL_CALL_OPEN.length, block.length - TOOL_CALL_CLOSE.length).trim()
  let parsed
  try {
    parsed = JSON.parse(inner)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const name = typeof parsed.name === "string" ? parsed.name.trim() : ""
  if (name.length === 0) return undefined
  return { toolName: name, arguments: renderArguments(parsed.arguments) }
}

function renderArguments(value) {
  if (typeof value === "string") return value
  if (value === undefined) return "{}"
  return safeJson(value) || "{}"
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
