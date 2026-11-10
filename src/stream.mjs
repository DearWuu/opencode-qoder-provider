/**
 * 文件职责：`-o stream-json --include-partial-messages` 输出的增量解析器，产出文本/推理块的开始、增量、结束回调与最终 result。
 * 上游：src/provider 的 doStream。
 * 下游：node:string_decoder。
 */
import { StringDecoder } from "node:string_decoder"

/**
 * `qoderclicn -o stream-json --include-partial-messages` 的增量解析器。
 *
 * CLI 每行打印一个 JSON 对象：
 *  - `system` 初始化/诊断事件（忽略）
 *  - `stream_event` 包装层，内含 Anthropic 风格的原始事件
 *    （`content_block_start` / `content_block_delta` / `content_block_stop` …）
 *  - 一个最终的 `result` 事件，携带用量与 Credits
 *  - 一条完整的 `assistant` 消息，重复已流式输出的文本（忽略）
 *
 * 未知事件类型与非 JSON 行一律忽略；缺失 `result` 由调用方检测（parser.result 保持 null）。
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
