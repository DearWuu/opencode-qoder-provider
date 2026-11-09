import { StringDecoder } from "node:string_decoder"

/**
 * Incremental parser for `qoderclicn -o stream-json --include-partial-messages`.
 *
 * The CLI prints one JSON object per line:
 *  - `system` init/diagnostic events (ignored)
 *  - `stream_event` wrappers carrying Anthropic-style raw events
 *    (`content_block_start` / `content_block_delta` / `content_block_stop` …)
 *  - one final `result` event carrying usage and credits
 *  - a full `assistant` message that repeats already streamed text (ignored)
 *
 * Unknown event types and non-JSON lines are ignored; a missing `result` is
 * detected by the caller (parser.result stays null).
 *
 * @param {{
 *   onTextStart?: (index: number) => void,
 *   onTextDelta?: (index: number, text: string) => void,
 *   onTextEnd?: (index: number) => void,
 *   onReasoningStart?: (index: number) => void,
 *   onReasoningDelta?: (index: number, text: string) => void,
 *   onReasoningEnd?: (index: number) => void,
 * }} [handlers]
 */
export function createStreamJsonParser(handlers = {}) {
  const decoder = new StringDecoder("utf8")
  const blockTypes = new Map()
  let pending = ""
  let result = null
  let sawTextDelta = false

  const handleLine = (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (!event || typeof event !== "object") return

    if (event.type === "result") {
      result = event
      return
    }
    if (event.type !== "stream_event") return

    const inner = event.event
    if (!inner || typeof inner !== "object") return
    const index = typeof inner.index === "number" ? inner.index : 0

    if (inner.type === "content_block_start") {
      const blockType = inner.content_block?.type
      blockTypes.set(index, blockType)
      if (blockType === "text") handlers.onTextStart?.(index)
      else if (blockType === "thinking") handlers.onReasoningStart?.(index)
    } else if (inner.type === "content_block_delta") {
      const delta = inner.delta
      if (!delta || typeof delta !== "object") return
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        sawTextDelta = true
        handlers.onTextDelta?.(index, delta.text)
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        handlers.onReasoningDelta?.(index, delta.thinking)
      }
    } else if (inner.type === "content_block_stop") {
      const blockType = blockTypes.get(index)
      if (blockType === "text") handlers.onTextEnd?.(index)
      else if (blockType === "thinking") handlers.onReasoningEnd?.(index)
    }
  }

  return {
    get result() {
      return result
    },
    get sawTextDelta() {
      return sawTextDelta
    },
    feed(chunk) {
      pending += decoder.write(typeof chunk === "string" ? chunk : Buffer.from(chunk))
      let newline
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) handleLine(line)
      }
    },
    end() {
      pending += decoder.end()
      const line = pending.trim()
      pending = ""
      if (line) handleLine(line)
    },
  }
}
