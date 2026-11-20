/**
 * 文件职责：把 AI SDK V3 prompt 拍平成纯文本，收集图片附件，并做 UTF-8 字节上限校验与媒体类型报错。
 * 上游：src/provider 的 doGenerate/doStream。
 * 下游：src/options（stdin/安全上限常量）、src/cli（把附件落成临时文件后传 `--attachment`）。
 */
import { CLI_STDIN_LIMIT_BYTES, MAX_PROMPT_BYTES } from "./options.mjs"

const encoder = new TextEncoder()

export const OUTPUT_CONSTRAINT = [
  "# Visible output constraints",
  "Visible text must contain only the answer or deliverable the user requested, or a brief progress update relevant to the task.",
  "Keep internal analysis and planning in the dedicated reasoning channel, not in visible text.",
  "Do not simulate conversation role headers, host acknowledgements, tool receipts, or execution results.",
  "Only the host can provide actual tool results; use the tool-call protocol when an action is needed and wait for its response.",
  "User-requested analysis reports, explanations, quotations of protocol text, and code examples are allowed as requested content; do not present them as actual host messages or tool execution.",
].join("\n")

/** prompt 含 Qoder CLI 无法消费的媒体内容时抛出的错误。 */
export class UnsupportedMediaError extends Error {
  constructor(message) {
    super(message)
    this.name = "UnsupportedMediaError"
  }
}

/** 序列化后的 prompt 超过安全 stdin 上限时抛出的错误。 */
export class PromptTooLargeError extends Error {
  constructor(bytes, limit) {
    super(
      `Serialized prompt is ${bytes} bytes, which exceeds the ${limit} byte limit of the Qoder provider. ` +
        `The Qoder CLI truncates stdin at ${CLI_STDIN_LIMIT_BYTES} bytes, so oversized prompts are rejected instead of being silently truncated.`,
    )
    this.name = "PromptTooLargeError"
    this.bytes = bytes
    this.limit = limit
  }
}

/**
 * 把 AI SDK V3 prompt 拍平成纯文本，单独抽出 system 内容，并收集其中的图片附件。
 *
 * Qoder CLI（1.1.90）在不用 `--input-format stream-json` 时只接受原始文本 prompt，
 * 因此对话文本在这里拍平；system 消息不混进用户文本，单独返回，由 provider 经
 * `--append-system-prompt` 传给 CLI（与工具桥接协议走同一条入口）。
 * 图片无法写进文本，改为收集成附件，由 src/cli 落成临时文件后以 `--attachment <file>` 传给 CLI。
 *
 * 附件顺序与 prompt 中出现的顺序一致，每项为 `{ mediaType, data }`：
 * `data` 是 `Uint8Array` 或 base64 字符串，`mediaType` 缺失时为 `undefined`。
 *
 * `system` 为全部 system 消息按出现顺序以空行连接；没有 system 消息时为 `""`。
 * user/assistant/tool 仍保留 `[user]` / `[assistant]` / `[tool]` 角色标记，出现在 `text` 里。
 *
 * @param {Array<any>} prompt
 * @returns {{ text: string, system: string, attachments: Array<{ mediaType: string | undefined, data: Uint8Array | string }> }}
 */
export function serializePrompt(prompt) {
  if (!Array.isArray(prompt)) {
    throw new Error("Qoder provider expects the prompt to be an array of messages.")
  }

  const blocks = []
  const systemBlocks = []
  const attachments = []
  for (const message of prompt) {
    if (!message || typeof message !== "object") {
      throw new Error("Qoder provider received a malformed prompt message.")
    }
    switch (message.role) {
      case "system":
        systemBlocks.push(String(message.content ?? ""))
        break
      case "user":
        blocks.push(`[user]\n${renderParts(message.content, "user", attachments)}`)
        break
      case "assistant": {
        const content = Array.isArray(message.content)
          ? message.content.filter((part) => part?.type !== "reasoning")
          : message.content
        if (Array.isArray(content) && content.length === 0 && message.content.length > 0) break
        blocks.push(`[assistant]\n${renderParts(content, "assistant", attachments)}`)
        break
      }
      case "tool":
        blocks.push(`[tool]\n${renderParts(message.content, "tool", attachments)}`)
        break
      default:
        throw new Error(`Qoder provider does not support the prompt role "${message.role}".`)
    }
  }

  return { text: blocks.join("\n\n"), system: systemBlocks.join("\n\n"), attachments }
}

/** 序列化后 prompt 的 UTF-8 字节数。
 *
 * @param {string} text
 * @returns {number}
 */
export function promptByteLength(text) {
  return encoder.encode(text).length
}

/**
 * prompt 超过 CLI 可消费的大小时明确失败。
 * CLI 在 8388608 字节处截断，本 provider 在 7340032 字节就拒绝。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {number}
 */
export function assertPromptSize(text, limit = MAX_PROMPT_BYTES) {
  const bytes = promptByteLength(text)
  if (bytes > limit) {
    throw new PromptTooLargeError(bytes, limit)
  }
  return bytes
}

function renderParts(parts, role, attachments) {
  if (typeof parts === "string") return parts
  if (!Array.isArray(parts)) return ""

  const rendered = []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    switch (part.type) {
      case "text":
        rendered.push(String(part.text ?? ""))
        break
      case "reasoning":
        rendered.push(`[reasoning]\n${String(part.text ?? "")}`)
        break
      case "tool-call":
        // 与工具桥接协议一致：宿主历史里的工具调用以 `<tool_call>` 信封回放，
        // 让模型看到自己上一轮发出的调用。
        rendered.push(renderToolCall(part))
        break
      case "tool-result":
        rendered.push(`[tool-result] ${part.toolName ?? "unknown"} (${part.toolCallId ?? ""})\n${renderToolOutput(part.output, attachments)}`)
        break
      case "tool-approval-response":
        rendered.push(
          `[tool-approval-response] ${part.approvalId ?? ""} ${part.approved ? "approved" : "denied"}${
            part.reason ? ` (${part.reason})` : ""
          }`,
        )
        break
      case "image":
        attachments.push(toAttachment(part, role))
        break
      case "file":
        if (!isImageMediaType(part.mediaType)) {
          throw new UnsupportedMediaError(
            `Qoder provider supports text and image input only, but a ${role} message contains a file part (${part.mediaType ?? "unknown"}).`,
          )
        }
        attachments.push(toAttachment(part, role))
        break
      default:
        throw new UnsupportedMediaError(
          `Qoder provider supports text and image input only, but a ${role} message contains an unsupported part of type "${part.type}".`,
        )
    }
  }
  return rendered.join("\n")
}

function isImageMediaType(mediaType) {
  return typeof mediaType === "string" && mediaType.trim().toLowerCase().startsWith("image/")
}

/**
 * 把 assistant 的 tool-call part 渲染成桥接协议信封。
 * `input` 在 AI SDK V3 里是 JSON 字符串（本 provider 产出的形状），
 * 兼容的对象形态则直接序列化。
 */
function renderToolCall(part) {
  const name = JSON.stringify(typeof part.toolName === "string" ? part.toolName : "unknown")
  const args = typeof part.input === "string" ? part.input : safeJson(part.input) || "{}"
  return `<tool_call>{"name":${name},"arguments":${args}}</tool_call>`
}

/**
 * 把 image/file part 规范化为附件：`{ mediaType, data }`。
 * image part 的载荷在 `image` 字段（AI SDK V3），file part 在 `data` 字段。
 */
function toAttachment(part, role) {
  const mediaType = typeof part.mediaType === "string" && part.mediaType.trim() ? part.mediaType.trim() : undefined
  const payload = part.type === "image" ? (part.image ?? part.data) : part.data
  return { mediaType, data: toAttachmentData(payload, mediaType, role) }
}

function toAttachmentData(payload, mediaType, role) {
  if (payload instanceof Uint8Array) return payload
  if (typeof payload === "string") {
    const base64 = payload.trim()
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return base64
    throw new UnsupportedMediaError(
      `Qoder provider supports image parts encoded as base64 data or Uint8Array, but a ${role} message contains a ${mediaType ?? "unknown"} payload of an unsupported string form.`,
    )
  }
  throw new UnsupportedMediaError(
    `Qoder provider supports image parts encoded as base64 data or Uint8Array, but a ${role} message contains a ${mediaType ?? "unknown"} payload of an unsupported type (remote URLs are not supported).`,
  )
}

function renderToolOutput(output, attachments) {
  if (!output || typeof output !== "object") return String(output ?? "")
  switch (output.type) {
    case "text":
      return String(output.value ?? "")
    case "json":
      return safeJson(output.value)
    case "execution-denied":
      return `[denied]${output.reason ? ` ${output.reason}` : ""}`
    case "error-text":
      return `[error] ${String(output.value ?? "")}`
    case "error-json":
      return `[error] ${safeJson(output.value)}`
    case "content":
      return renderParts(output.value, "tool", attachments)
    default:
      return safeJson(output)
  }
}

function safeJson(value) {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}
