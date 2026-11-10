/**
 * 文件职责：Qoder provider runtime：把 AI SDK V3 的 doGenerate/doStream 落到 Qoder CLI 调用，并写调用日志。
 * 上游：provider.mjs 再导出、index.ts 的 createQoder。
 * 下游：src/cli、src/logger、src/prompt、src/result、src/stream、src/options。
 */
import { MAX_STDOUT_BYTES, buildCliArgs, parseCliResult, runCli } from "./cli.mjs"
import { appendCallLog, buildLogEntry } from "./logger.mjs"
import { assertPromptSize, serializePrompt } from "./prompt.mjs"
import { ModelFallbackError, buildGenerateResult, detectFallback, summarizeModelUsage } from "./result.mjs"
import { createStreamJsonParser } from "./stream.mjs"
import { PROVIDER_ID, resolveOptions } from "./options.mjs"

/**
 * 创建 Qoder AI SDK provider。
 *
 * 返回对象实现 OpenCode 使用的 AI SDK provider 协议：
 * `languageModel(modelID)` 返回一个驱动 Qoder CLI 的 LanguageModelV3。
 *
 * 调用方：index.ts 的 setup（经 provider.mjs 再导出给 OpenCode）。
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] `qoderclicn` 路径（默认：随包 CLI → `QODER_CLI_PATH` → `PATH`）。
 * @param {string} [options.permissionMode] Qoder CLI 权限模式（默认 `bypass_permissions`，风险自担）。
 * @param {number} [options.timeoutMs] 单次调用总超时（默认 30 分钟）。
 * @param {number} [options.idleTimeoutMs] stdout/stderr 无活动超时（默认 180000 毫秒）。
 * @param {number} [options.contextLimit] 推导近似 token 数用的上下文窗口（默认 200000）。
 * @param {string} [options.logFile] JSONL 调用日志路径。
 * @param {string} [options.cwd] CLI 运行的工作目录。
 * @param {string[]} [options.additionalDirs] 额外目录，逐个映射为 `--add-dir`。
 * @param {string[] | ""} [options.cliTools] 内置工具允许清单（`--tools`），`""` 表示全部禁用。
 * @returns {{ specificationVersion: "v3", provider: string, languageModel: (modelID: string) => any, chat: (modelID: string) => any }}
 */
export function createQoder(options = {}) {
  const resolved = resolveOptions(options)
  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
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
  return {
    specificationVersion: "v3",
    provider: PROVIDER_ID,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(callOptions = {}) {
      const prompt = serializePrompt(callOptions.prompt)
      assertPromptSize(prompt)
      const outcome = await execute({
        modelID,
        resolved,
        prompt,
        signal: callOptions.abortSignal,
        maxOutputTokens: callOptions.maxOutputTokens,
      })
      return outcome.result
    },
    async doStream(callOptions = {}) {
      const prompt = serializePrompt(callOptions.prompt)
      assertPromptSize(prompt)
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
          const parser = createStreamJsonParser({
            onTextStart: (index) => openBlock("text", index),
            onTextDelta: (index, text) => deltaBlock("text", index, text),
            onTextEnd: closeBlock,
            onReasoningStart: (index) => openBlock("reasoning", index),
            onReasoningDelta: (index, text) => deltaBlock("reasoning", index, text),
            onReasoningEnd: closeBlock,
          })
          emit({ type: "stream-start", warnings: [] })
          try {
            const outcome = await execute({
              modelID,
              resolved,
              prompt,
              signal: abortController.signal,
              parser,
              maxOutputTokens,
            })
            if (cancelled) return
            if (!parser.sawTextDelta) {
              // CLI 没有产生任何 text delta（旧版本或空 text 块）：
              // 先关闭所有仍打开的块，再把完整文本作为一个全新的回退块投递。
              // 回退 id 必须唯一：复用解析器块 id 会对一个已关闭的 id 再发 text-start，
              // 形成重复的块序列。
              for (const index of [...openBlocks.keys()]) closeBlock(index)
              const fallbackId = "qoder-text-fallback"
              const text = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
              emit({ type: "text-start", id: fallbackId })
              if (text.length > 0) {
                emit({ type: "text-delta", id: fallbackId, delta: text })
              }
              emit({ type: "text-end", id: fallbackId })
            }
            for (const index of [...openBlocks.keys()]) closeBlock(index)
            emit({
              type: "finish",
              usage: outcome.result.usage,
              finishReason: outcome.result.finishReason,
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
}

/** 执行一次 Qoder CLI 调用，并把结果翻译成 AI SDK V3 的形状。 */
async function execute({ modelID, resolved, prompt, signal, parser, maxOutputTokens }) {
  const args = buildCliArgs({
    modelID,
    cwd: resolved.cwd,
    permissionMode: resolved.permissionMode,
    additionalDirs: resolved.additionalDirs,
    cliTools: resolved.cliTools,
    maxOutputTokens,
    stream: parser !== undefined,
  })

  const run = await runCli({
    cliPath: resolved.cliPath,
    args,
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

  record({
    actualModel: fallback.actualModel,
    modelFallback: fallback.fellBack,
    usageModelKey: summary.usageModelKey,
    usageModelKeys: summary.usageModelKeys,
    credits: typeof raw?.total_credits === "number" ? raw.total_credits : summary.credits,
    isError: raw?.is_error === true || fallback.fellBack,
    sessionId: raw?.session_id,
  })

  if (fallback.fellBack) throw new ModelFallbackError(modelID, fallback.actualModel)

  const result = buildGenerateResult({ raw, requestedModel: modelID, contextLimit: resolved.contextLimit })
  return { result, raw, run }
}

function logCall(resolved, entry) {
  appendCallLog(resolved.logFile, buildLogEntry(entry))
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
