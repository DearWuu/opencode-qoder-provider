/**
 * 文件职责：把 AI SDK V3 prompt 拍平成纯文本，并做 UTF-8 字节上限校验与媒体类型报错。
 * 上游：src/provider 的 doGenerate/doStream。
 * 下游：src/options（stdin/安全上限常量）。
 */
import { CLI_STDIN_LIMIT_BYTES, MAX_PROMPT_BYTES } from "./options.mjs"

const encoder = new TextEncoder()

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
 * 把 AI SDK V3 prompt 序列化成写入 `qoderclicn` stdin 的纯文本。
 *
 * Qoder CLI（1.1.85）在不用 `--input-format stream-json` 时只接受原始文本 prompt，
 * 因此在这里把对话拍平。
 *
 * @param {Array<any>} prompt
 * @returns {string}
 */
export function serializePrompt(prompt) {
  if (!Array.isArray(prompt)) {
    throw new Error("Qoder provider expects the prompt to be an array of messages.")
  }

  const blocks = []
  for (const message of prompt) {
    if (!message || typeof message !== "object") {
      throw new Error("Qoder provider received a malformed prompt message.")
    }
    switch (message.role) {
      case "system":
        blocks.push(`[system]\n${String(message.content ?? "")}`)
        break
      case "user":
        blocks.push(`[user]\n${renderParts(message.content, "user")}`)
        break
      case "assistant":
        blocks.push(`[assistant]\n${renderParts(message.content, "assistant")}`)
        break
      case "tool":
        blocks.push(`[tool]\n${renderParts(message.content, "tool")}`)
        break
      default:
        throw new Error(`Qoder provider does not support the prompt role "${message.role}".`)
    }
  }

  return blocks.join("\n\n")
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

function renderParts(parts, role) {
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
        rendered.push(`[tool-call] ${part.toolName ?? "unknown"} (${part.toolCallId ?? ""})\n${safeJson(part.input)}`)
        break
      case "tool-result":
        rendered.push(`[tool-result] ${part.toolName ?? "unknown"} (${part.toolCallId ?? ""})\n${renderToolOutput(part.output)}`)
        break
      case "tool-approval-response":
        rendered.push(
          `[tool-approval-response] ${part.approvalId ?? ""} ${part.approved ? "approved" : "denied"}${
            part.reason ? ` (${part.reason})` : ""
          }`,
        )
        break
      case "file":
        throw new UnsupportedMediaError(
          `Qoder provider supports text input only, but a ${role} message contains a file part (${part.mediaType ?? "unknown"}).`,
        )
      default:
        if (part.type === "image") {
          throw new UnsupportedMediaError(
            `Qoder provider supports text input only, but a ${role} message contains an image part (${part.mediaType ?? "unknown"}).`,
          )
        }
        throw new UnsupportedMediaError(
          `Qoder provider supports text input only, but a ${role} message contains an unsupported part of type "${part.type}".`,
        )
    }
  }
  return rendered.join("\n")
}

function renderToolOutput(output) {
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
      return renderParts(output.value, "tool")
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
