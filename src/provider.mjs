/**
 * 文件职责：Qoder provider runtime：把 AI SDK V3 的 doGenerate/doStream 落到 Qoder CLI 调用，并写调用日志；
 * 宿主传入工具时启用文本协议桥接（`<tool_call>` 信封 ↔ AI SDK tool-call part）。
 * 上游：provider.mjs 再导出、index.ts 的 createQoder。
 * 下游：src/cli、src/logger、src/prompt、src/result、src/stream、src/options、src/tools。
 */
import { MAX_STDOUT_BYTES, buildCliArgs, isReasoningEffort, parseCliResult, runCli } from "./cli.mjs"
import { appendCallLog, buildLogEntry } from "./logger.mjs"
import { OUTPUT_CONSTRAINT, assertPromptSize, serializePrompt } from "./prompt.mjs"
import { ModelFallbackError, buildGenerateResult, detectFallback, summarizeModelUsage } from "./result.mjs"
import { createStreamJsonParser } from "./stream.mjs"
import { createToolCallScanner, extractToolCalls, functionTools, renderToolProtocol, translateNativeToolCall } from "./tools.mjs"
import { resolveOptions } from "./options.mjs"

/** 桥接模式下正文块在 `openBlocks` 里的键：与 CLI 的 content block index 不冲突。 */
const BRIDGE_TEXT_BLOCK = "bridge"

/**
 * 创建 Qoder AI SDK provider。
 *
 * 返回对象实现 OpenCode 使用的 AI SDK provider 协议：
 * `languageModel(modelID)` 返回一个驱动 Qoder CLI 的 LanguageModelV3。
 *
 * 每个变体（CN / 海外）各自创建一份：provider ID、CLI 路径与日志归属都随变体走。
 *
 * 调用方：index.ts 的 setup（经 provider.mjs 再导出给 OpenCode）。
 *
 * @param {object} [options]
 * @param {string} [options.variant] 变体 ID（`qodercn` / `qoder`），缺省 CN。
 * @param {string} [options.cliPath] 该变体的 CLI 路径（默认按变体解析）。
 * @param {string} [options.permissionMode] Qoder CLI 权限模式（默认 `bypass_permissions`，风险自担）。
 * @param {number} [options.timeoutMs] 单次调用总超时（默认 30 分钟）。
 * @param {number} [options.idleTimeoutMs] stdout/stderr 无活动超时（默认 180000 毫秒）。
 * @param {number} [options.contextLimit] 推导近似 token 数用的上下文窗口（默认 200000）。
 * @param {string} [options.logFile] JSONL 调用日志路径。
 * @param {string} [options.cwd] CLI 运行的工作目录。
 * @param {string[]} [options.additionalDirs] 额外目录，逐个映射为 `--add-dir`。
 * @param {string[] | ""} [options.cliTools] 内置工具允许清单（`--tools`），`""` 表示全部禁用。
 * @param {boolean | string} [options.toolBridge] 工具桥接开关（默认开），`false` 关闭文本协议。
 * @param {Record<string, { cliPath?: string }>} [options.variants] 按变体 ID 覆盖的选项（`cliPath`）。
 * @returns {{ specificationVersion: "v3", provider: string, languageModel: (modelID: string) => any, chat: (modelID: string) => any }}
 */
export function createQoder(options = {}) {
  const resolved = resolveOptions(options)
  return {
    specificationVersion: "v3",
    provider: resolved.variantId,
    languageModel(modelID) {
      return createLanguageModel(modelID, resolved)
    },
    chat(modelID) {
      return createLanguageModel(modelID, resolved)
    },
  }
}

/**
 * 为某个 Qoder 模型创建单个 LanguageModelV3 实例。
 *
 * @param {string} modelID
 * @param {Record<string, any>} resolved
 * @returns {any}
 */
export function createLanguageModel(modelID, resolved) {
  const model = {
    specificationVersion: "v3",
    provider: resolved.variantId,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(callOptions = {}) {
      const { text, system, attachments } = serializePrompt(callOptions.prompt)
      assertPromptSize(text)
      const plan = toolBridgePlan(resolved, callOptions)
      if (plan.bridge) {
        // 原生 tool_use 只能从流式输出里拦截（CLI 会自己执行原生调用、把错误喂回模型），
        // 所以桥接的 doGenerate 复用 doStream，再汇总成一次性结果。
        const { stream } = await model.doStream(callOptions)
        let streamedText = ""
        const calls = []
        let warnings = plan.warnings
        let finish
        for await (const part of stream) {
          if (part.type === "text-delta") streamedText += part.delta
          else if (part.type === "tool-call") calls.push(part)
          else if (part.type === "stream-start") warnings = part.warnings ?? warnings
          else if (part.type === "error") throw part.error
          else if (part.type === "finish") finish = part
        }
        if (!finish) throw new Error("The Qoder CLI stream ended without a finish event.")
        return {
          content: [
            ...(streamedText.trim().length > 0 ? [{ type: "text", text: streamedText }] : []),
            ...calls.map((call) => ({
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: call.input,
            })),
          ],
          finishReason: finish.finishReason,
          usage: finish.usage,
          warnings,
          providerMetadata: finish.providerMetadata,
        }
      }

      const constraint = resolved.toolBridge === true ? OUTPUT_CONSTRAINT : undefined
      const appendSystemPrompt = [system, constraint, plan.protocol].filter(Boolean).join("\n\n") || undefined
      const outcome = await execute({
        modelID,
        resolved,
        prompt: text,
        attachments,
        signal: callOptions.abortSignal,
        maxOutputTokens: callOptions.maxOutputTokens,
        bridge: plan.bridge,
        appendSystemPrompt,
        reasoningEffort: readReasoningEffort(callOptions, resolved.variantId),
      })
      return outcome.result
    },
    async doStream(callOptions = {}) {
      const { text, system, attachments } = serializePrompt(callOptions.prompt)
      assertPromptSize(text)
      const plan = toolBridgePlan(resolved, callOptions)
      const constraint = resolved.toolBridge === true ? OUTPUT_CONSTRAINT : undefined
      const appendSystemPrompt = [system, constraint, plan.protocol].filter(Boolean).join("\n\n") || undefined
      const reasoningEffort = readReasoningEffort(callOptions, resolved.variantId)
      const maxOutputTokens = callOptions.maxOutputTokens
      const abortController = new AbortController()
      const externalSignal = callOptions.abortSignal
      let cancelled = false
      const abort = (reason) => {
        if (!abortController.signal.aborted) abortController.abort(reason)
      }
      const onExternalAbort = () => abort(externalSignal?.reason)
      const cleanup = () => externalSignal?.removeEventListener("abort", onExternalAbort)
      if (externalSignal?.aborted) onExternalAbort()
      else externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

      const stream = new ReadableStream({
        async start(controller) {
          // cancel 可能在 `execute` 挂起期间到达；cancel 之后再 enqueue 会抛错，
          // 所以每次 emit 都做守卫并吞掉异常。
          const emit = (chunk) => {
            if (cancelled) return
            try {
              controller.enqueue(chunk)
            } catch {}
          }
          // 真正的增量流式：进程运行期间，解析器把 CLI 的 `text_delta` 事件
          // 实时转成 AI SDK 的 `text-delta` part。
          const openBlocks = new Map()
          const openBlock = (kind, index) => {
            const id = `qoder-${kind}-${index}`
            openBlocks.set(index, { kind, id })
            emit({ type: `${kind}-start`, id })
          }
          const deltaBlock = (kind, index, text) => {
            let block = openBlocks.get(index)
            if (!block) {
              const id = `qoder-${kind}-${index}`
              block = { kind, id }
              openBlocks.set(index, block)
              emit({ type: `${kind}-start`, id })
            }
            if (text.length > 0) emit({ type: `${kind}-delta`, id: block.id, delta: text })
          }
          const closeBlock = (index) => {
            const block = openBlocks.get(index)
            if (!block) return
            openBlocks.delete(index)
            emit({ type: `${block.kind}-end`, id: block.id })
          }
          // 桥接模式下正文先进扫描器：信封被扣住解析，只有信封之外的文本
          // 才按现有 text block 协议输出。
          const scanner = plan.bridge
            ? createToolCallScanner({
                onText: (chunk) => {
                  if (!nativeCallFound) deltaBlock("text", BRIDGE_TEXT_BLOCK, chunk)
                },
              })
            : undefined
          // CLI 的原生工具（mcp_call / mcp_list 等）会把模型绕开文本协议的调用
          // 自己执行并喂回错误。桥接时把发往宿主工具的原生调用拦下来翻译成宿主调用，
          // 并丢弃之后那几轮错误自愈输出。
          const hostToolNames = new Set(plan.tools.map((tool) => tool.name))
          const nativeBlocks = new Map()
          const nativeCalls = []
          let nativeCallFound = false
          const rememberNativeCall = (call) => {
            const key = `${call.toolName}\u0000${call.arguments}`
            if (nativeCalls.some((existing) => `${existing.toolName}\u0000${existing.arguments}` === key)) return
            nativeCalls.push(call)
            nativeCallFound = true
          }
          const parser = createStreamJsonParser({
            // 桥接模式下正文块由扫描器按「信封之外的文本」懒创建：
            // 全部输出都是 tool_call 时不会留下空的 text 块。
            onTextStart: (index) => {
              if (!scanner && !nativeCallFound) openBlock("text", index)
            },
            onTextDelta: (index, delta) => {
              if (nativeCallFound) return
              if (scanner) scanner.push(delta)
              else deltaBlock("text", index, delta)
            },
            onTextEnd: (index) => {
              if (!scanner) closeBlock(index)
            },
            onReasoningStart: (index) => {
              if (!nativeCallFound) openBlock("reasoning", index)
            },
            onReasoningDelta: (index, delta) => {
              if (!nativeCallFound) deltaBlock("reasoning", index, delta)
            },
            onReasoningEnd: closeBlock,
            onToolStart: (index, block) => {
              if (!plan.bridge) return
              nativeBlocks.set(index, {
                name: typeof block?.name === "string" ? block.name : "",
                json: "",
              })
            },
            onToolDelta: (index, partialJson) => {
              const pending = nativeBlocks.get(index)
              if (pending) pending.json += partialJson
            },
            onToolEnd: (index) => {
              const pending = nativeBlocks.get(index)
              if (!pending) return
              nativeBlocks.delete(index)
              const call = translateNativeToolCall(pending.name, pending.json, hostToolNames)
              if (call) rememberNativeCall(call)
            },
          })
          emit({ type: "stream-start", warnings: plan.warnings })
          try {
            const outcome = await execute({
              modelID,
              resolved,
              prompt: text,
              attachments,
              signal: abortController.signal,
              parser,
              maxOutputTokens,
              bridge: plan.bridge,
              appendSystemPrompt,
              reasoningEffort,
              nativeToolCalls: nativeCalls,
            })
            if (cancelled) return
            if (!parser.sawTextDelta) {
              // CLI 没有产生任何 text delta（旧版本或空 text 块）：
              // 先关闭解析器遗留的块（桥接模式下没有 text 块，但可能有 reasoning 块），
              // 避免与随后新建的正文块交错。
              for (const index of [...openBlocks.keys()]) closeBlock(index)
              if (scanner) {
                // 桥接模式：完整正文交给扫描器，信封被解析成调用而不是泄漏成正文。
                // 原生调用已经命中宿主工具时，正文只是 CLI 的错误自愈输出，丢弃。
                if (!nativeCallFound) {
                  const fallbackText = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
                  scanner.push(fallbackText)
                }
              } else {
                // 非桥接模式：沿用原来的回退文本块。回退 id 必须唯一：复用解析器块 id
                // 会对一个已关闭的 id 再发 text-start，形成重复的块序列。
                const fallbackId = "qoder-text-fallback"
                const fallbackText = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
                emit({ type: "text-start", id: fallbackId })
                if (fallbackText.length > 0) {
                  emit({ type: "text-delta", id: fallbackId, delta: fallbackText })
                }
                emit({ type: "text-end", id: fallbackId })
              }
            }
            // 冲刷扫描器扣住的尾巴（可能是未闭合信封，按原文输出），
            // 再关闭全部仍打开的块，最后逐条发出工具调用。
            const candidates = [...nativeCalls, ...(scanner ? scanner.finish().calls : [])]
            const seenCalls = new Set()
            const calls = []
            for (const candidate of candidates) {
              const key = `${candidate.toolName}\u0000${candidate.arguments}`
              if (seenCalls.has(key)) continue
              seenCalls.add(key)
              calls.push(candidate)
            }
            for (const index of [...openBlocks.keys()]) closeBlock(index)
            calls.forEach((call, index) => {
              const id = toolCallId(index)
              emit({ type: "tool-input-start", id, toolName: call.toolName })
              if (call.arguments.length > 0) emit({ type: "tool-input-delta", id, delta: call.arguments })
              emit({ type: "tool-input-end", id })
              emit({ type: "tool-call", toolCallId: id, toolName: call.toolName, input: call.arguments })
            })
            emit({
              type: "finish",
              usage: outcome.result.usage,
              finishReason: calls.length > 0
                ? { unified: "tool-calls", raw: outcome.result.finishReason.raw }
                : outcome.result.finishReason,
              providerMetadata: outcome.result.providerMetadata,
            })
          } catch (error) {
            if (!cancelled) {
              try {
                controller.enqueue({ type: "error", error })
              } catch {}
            }
          } finally {
            cleanup()
            if (!cancelled) {
              try {
                controller.close()
              } catch {}
            }
          }
        },
        cancel(reason) {
          cancelled = true
          cleanup()
          abort(reason)
        },
      })
      return { stream }
    },
  }
  return model
}

/**
 * 决定本次调用是否启用工具桥接，并渲染要追加进 system 的协议说明。
 *
 * - `resolved.toolBridge` 关闭或宿主本轮没有 function 工具：`bridge: false`，不带协议；
 * - 否则 `bridge: true`，协议由 `renderToolProtocol` 按工具清单与 `toolChoice` 渲染。
 *
 * provider 工具（`type: "provider"`）无法经文本协议交给宿主执行，跳过并产出
 * `{ type: "other", message }` warning，与 AI SDK 的 warning 形状一致。
 *
 * @param {Record<string, any>} resolved `resolveOptions` 的结果。
 * @param {{ tools?: Array<any>, toolChoice?: { type?: string, toolName?: string } }} [callOptions]
 * @returns {{ bridge: boolean, protocol: string | undefined, tools: Array<any>, warnings: Array<{ type: "other", message: string }> }}
 */
function toolBridgePlan(resolved, callOptions = {}) {
  const warnings = []
  const { tools, skipped } = functionTools(callOptions.tools)
  for (const name of skipped) {
    warnings.push({
      type: "other",
      message: `Qoder provider skipped the provider tool "${name}": only function tools can be bridged through the text protocol.`,
    })
  }
  if (resolved.toolBridge !== true || tools.length === 0) {
    return { bridge: false, protocol: undefined, tools, warnings }
  }
  return { bridge: true, protocol: renderToolProtocol(tools, callOptions.toolChoice), tools, warnings }
}

/** 上一次发出的桥接 toolCallId 时间戳（毫秒），保证同一毫秒内的多次生成也不重复。 */
let lastToolCallStamp = 0

/**
 * 为桥接产生的工具调用生成稳定、唯一的 toolCallId。
 * 形状为 `qoder-bridge-<base36 时间戳>-<序号>`，序号是本次回答内的调用下标。
 *
 * @param {number} index 本次回答内的调用下标。
 * @returns {string}
 */
function toolCallId(index) {
  const now = Date.now()
  lastToolCallStamp = now > lastToolCallStamp ? now : lastToolCallStamp + 1
  return `qoder-bridge-${lastToolCallStamp.toString(36)}-${index}`
}

/**
 * 读出本次调用的思考强度。
 *
 * 读取顺序：`providerOptions[providerId].reasoningEffort` →
 * `providerOptions[providerId].settings.reasoningEffort`（opencode 内置变体形状）→
 * `providerOptions.reasoningEffort`（顶层兼容）→ `callOptions.reasoningEffort`。
 * 只接受 Qoder CLI 的真实枚举；非法值与缺省一律返回 `undefined`。
 *
 * 调用方：src/provider 的 doGenerate/doStream。
 *
 * @param {Record<string, any>} [callOptions]
 * @param {string} [providerId]
 * @returns {string | undefined}
 */
export function readReasoningEffort(callOptions = {}, providerId) {
  const providerOptions = callOptions?.providerOptions
  const scoped = providerId ? providerOptions?.[providerId] : undefined
  const candidates = [
    scoped?.reasoningEffort,
    scoped?.settings?.reasoningEffort,
    providerOptions?.reasoningEffort,
    callOptions?.reasoningEffort,
  ]
  for (const candidate of candidates) {
    if (isReasoningEffort(candidate)) return candidate
  }
  return undefined
}

/** 执行一次 Qoder CLI 调用，并把结果翻译成 AI SDK V3 的形状。 */
async function execute({ modelID, resolved, prompt, attachments, signal, parser, maxOutputTokens, bridge, appendSystemPrompt, reasoningEffort, nativeToolCalls }) {
  // 实际下发给 CLI 的档位：auto（默认档）与非法值都不传 flag，日志里也只记真正生效的档位。
  const effectiveReasoningEffort = isReasoningEffort(reasoningEffort) && reasoningEffort !== "auto" ? reasoningEffort : undefined
  const args = buildCliArgs({
    modelID,
    cwd: resolved.cwd,
    permissionMode: resolved.permissionMode,
    additionalDirs: resolved.additionalDirs,
    cliTools: resolved.cliTools,
    maxOutputTokens,
    stream: parser !== undefined,
    bridge: bridge === true,
    appendSystemPrompt,
    reasoningEffort: effectiveReasoningEffort,
  })

  const run = await runCli({
    cliPath: resolved.cliPath,
    args,
    attachments,
    input: prompt,
    cwd: resolved.cwd,
    timeoutMs: resolved.timeoutMs,
    idleTimeoutMs: resolved.idleTimeoutMs,
    signal,
    // 流模式下 stdout 由解析器回调消费；再保留原始字节副本（及其字符串解码）
    // 纯属额外开销。
    collectStdout: parser === undefined,
    onStdout: parser ? (chunk) => parser.feed(chunk) : undefined,
  })

  const diagnostics = runDiagnostics(run, parser)
  const record = (entry) => logCall(resolved, {
    requestedModel: modelID,
    durationMs: run.durationMs,
    exitCode: run.code,
    ...diagnostics,
    bridge: bridge === true,
    reasoningEffort: effectiveReasoningEffort,
    ...entry,
  })

  if (run.aborted) {
    record({ isError: true, aborted: true, timedOut: run.timedOut })
    throw abortError()
  }

  if (run.timedOut) {
    record({ isError: true, timedOut: true })
    throw timeoutError(resolved, run)
  }

  if (run.stdoutTruncated) {
    record({ isError: true })
    throw new Error(`Qoder CLI stdout exceeded the ${MAX_STDOUT_BYTES} byte limit and was truncated.`)
  }

  let raw
  try {
    if (parser) {
      parser.end()
      raw = parser.result
      if (!raw) throw new Error("The Qoder CLI stream ended without a result event.")
    } else {
      raw = parseCliResult(run.stdout)
    }
    diagnostics.sawResult = true
  } catch (error) {
    record({ isError: true })
    throw cliFailure(run, error)
  }

  const summary = summarizeModelUsage(raw)
  const fallback = detectFallback(modelID, run.stderr)
  const result = buildGenerateResult({ raw, requestedModel: modelID, contextLimit: resolved.contextLimit })
  const body = result.content.map((part) => (part.type === "text" ? part.text : "")).join("")

  record({
    actualModel: fallback.actualModel,
    modelFallback: fallback.fellBack,
    usageModelKey: summary.usageModelKey,
    usageModelKeys: summary.usageModelKeys,
    credits: typeof raw?.total_credits === "number" ? raw.total_credits : summary.credits,
    isError: raw?.is_error === true || fallback.fellBack,
    sessionId: raw?.session_id,
    // 桥接模式下回答正文里的信封才是工具调用，日志记解析出的条数；
    // 原生 tool_use 拦下来的调用单独计数。
    toolCalls: bridge === true
      ? extractToolCalls(body).calls.length + (Array.isArray(nativeToolCalls) ? nativeToolCalls.length : 0)
      : undefined,
  })

  if (fallback.fellBack) throw new ModelFallbackError(modelID, fallback.actualModel)

  return { result, raw, run }
}

function logCall(resolved, entry) {
  appendCallLog(resolved.logFile, buildLogEntry({ variant: resolved.variantId, provider: resolved.variantId, ...entry }))
}

function cliFailure(run, cause) {
  const details = run.stderr.trim().length > 0 ? run.stderr.trim().slice(0, 500) : String(cause?.message ?? cause)
  const error = new Error(`Qoder CLI failed (exit ${run.code}). ${details}`)
  error.cause = cause
  return error
}

function abortError() {
  const error = new Error("Qoder CLI call was aborted.")
  error.name = "AbortError"
  return error
}

function runDiagnostics(run, parser) {
  return {
    timeoutKind: run.timeoutKind,
    lastEventType: run.lastEventType,
    lastEventAgoMs: run.lastEventAgoMs,
    sawStdout: run.sawStdout,
    sawStderr: run.sawStderr,
    sawTextDelta: parser?.sawTextDelta === true,
    sawResult: false,
  }
}

function timeoutError(resolved, run) {
  const idle = run.timeoutKind === "idle"
  const timeoutMs = idle ? resolved.idleTimeoutMs : resolved.timeoutMs
  const error = new Error(idle
    ? `Qoder CLI call timed out after ${timeoutMs} ms without stdout or stderr activity.`
    : `Qoder CLI call timed out after ${timeoutMs} ms.`)
  error.name = "TimeoutError"
  error.timeoutKind = idle ? "idle" : "total"
  error.cause = run.stderr.trim().slice(0, 500)
  return error
}
