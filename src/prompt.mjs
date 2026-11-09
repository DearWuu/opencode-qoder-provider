import { CLI_STDIN_LIMIT_BYTES, MAX_PROMPT_BYTES } from "./options.mjs"

const encoder = new TextEncoder()

/** Error thrown when a prompt contains media that the Qoder CLI cannot consume. */
export class UnsupportedMediaError extends Error {
  constructor(message) {
    super(message)
    this.name = "UnsupportedMediaError"
  }
}

/** Error thrown when the serialized prompt exceeds the safe stdin limit. */
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
 * Serialize an AI SDK V3 prompt into the plain text that is piped to
 * `qoderclicn` stdin.
 *
 * The Qoder CLI (1.1.85) only accepts a raw text prompt on stdin when it is not
 * using `--input-format stream-json`, so the conversation is flattened here.
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

/** UTF-8 byte size of the serialized prompt.
 *
 * @param {string} text
 * @returns {number}
 */
export function promptByteLength(text) {
  return encoder.encode(text).length
}

/**
 * Fail loudly when the prompt is larger than the CLI can consume.
 * The CLI truncates at 8388608 bytes, this provider refuses at 7340032 bytes.
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
