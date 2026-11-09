import { MAX_STDOUT_BYTES, buildCliArgs, parseCliResult, runCli } from "./cli.mjs"
import { appendCallLog, buildLogEntry } from "./logger.mjs"
import { assertPromptSize, serializePrompt } from "./prompt.mjs"
import { ModelFallbackError, buildGenerateResult, detectFallback, summarizeModelUsage } from "./result.mjs"
import { createStreamJsonParser } from "./stream.mjs"
import { PROVIDER_ID, resolveOptions } from "./options.mjs"

/**
 * Create the Qoder AI SDK provider.
 *
 * The returned object implements the AI SDK provider protocol used by OpenCode:
 * `languageModel(modelID)` returns a LanguageModelV3 that shells out to the
 * Qoder CLI.
 *
 * @param {object} [options]
 * @param {string} [options.cliPath] Path to `qoderclicn` (default: bundled CLI, then `QODER_CLI_PATH`, then `PATH`).
 * @param {string} [options.permissionMode] Qoder CLI permission mode (default `default`).
 * @param {number} [options.timeoutMs] Per call timeout (default 30 minutes).
 * @param {number} [options.contextLimit] Context window used to approximate token counts (default 200000).
 * @param {string} [options.logFile] JSONL call log path.
 * @param {string} [options.cwd] Working directory for the CLI run.
 * @param {string[]} [options.additionalDirs] Extra directories passed as repeated `--add-dir`.
 * @param {string[] | ""} [options.cliTools] Built-in tool allowlist (`--tools`), or `""` to disable all.
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
 * Create a single LanguageModelV3 instance for one Qoder model.
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
      const outcome = await execute({ modelID, resolved, prompt, signal: callOptions.abortSignal })
      return outcome.result
    },
    async doStream(callOptions = {}) {
      const prompt = serializePrompt(callOptions.prompt)
      assertPromptSize(prompt)
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
          // A cancel can land while `execute` is pending; enqueues after a
          // cancel would throw, so every emit is guarded and swallowed.
          const emit = (chunk) => {
            if (cancelled) return
            try {
              controller.enqueue(chunk)
            } catch {}
          }
          // Real partial streaming: the parser forwards `text_delta` events
          // from the CLI as AI SDK `text-delta` parts while the process runs.
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
            const outcome = await execute({ modelID, resolved, prompt, signal: abortController.signal, parser })
            if (cancelled) return
            if (!parser.sawTextDelta) {
              // The CLI produced no partial events (older build): emit the
              // finished text as one delta so the stream still delivers.
              const text = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
              emit({ type: "text-start", id: "qoder-text-0" })
              if (text.length > 0) {
                emit({ type: "text-delta", id: "qoder-text-0", delta: text })
              }
              emit({ type: "text-end", id: "qoder-text-0" })
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

/** Run one Qoder CLI call and translate the result into the AI SDK V3 shape. */
async function execute({ modelID, resolved, prompt, signal, parser }) {
  const args = buildCliArgs({
    modelID,
    cwd: resolved.cwd,
    permissionMode: resolved.permissionMode,
    additionalDirs: resolved.additionalDirs,
    cliTools: resolved.cliTools,
    stream: parser !== undefined,
  })

  const run = await runCli({
    cliPath: resolved.cliPath,
    args,
    input: prompt,
    cwd: resolved.cwd,
    timeoutMs: resolved.timeoutMs,
    signal,
    onStdout: parser ? (chunk) => parser.feed(chunk) : undefined,
  })

  if (run.aborted) {
    logCall(resolved, {
      requestedModel: modelID,
      durationMs: run.durationMs,
      isError: true,
      exitCode: run.code,
      aborted: true,
      timedOut: run.timedOut,
    })
    throw abortError()
  }

  if (run.timedOut) {
    logCall(resolved, {
      requestedModel: modelID,
      durationMs: run.durationMs,
      isError: true,
      exitCode: run.code,
      timedOut: true,
    })
    throw timeoutError(resolved.timeoutMs, run)
  }

  if (run.stdoutTruncated) {
    logCall(resolved, {
      requestedModel: modelID,
      durationMs: run.durationMs,
      isError: true,
      exitCode: run.code,
    })
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
  } catch (error) {
    logCall(resolved, {
      requestedModel: modelID,
      durationMs: run.durationMs,
      isError: true,
      exitCode: run.code,
    })
    throw cliFailure(run, error)
  }

  const summary = summarizeModelUsage(raw)
  const fallback = detectFallback(modelID, run.stderr)

  logCall(resolved, {
    requestedModel: modelID,
    actualModel: fallback.actualModel,
    modelFallback: fallback.fellBack,
    usageModelKey: summary.usageModelKey,
    usageModelKeys: summary.usageModelKeys,
    credits: typeof raw?.total_credits === "number" ? raw.total_credits : summary.credits,
    durationMs: run.durationMs,
    isError: raw?.is_error === true || fallback.fellBack,
    exitCode: run.code,
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

function timeoutError(timeoutMs, run) {
  const error = new Error(`Qoder CLI call timed out after ${timeoutMs} ms.`)
  error.cause = run.stderr.trim().slice(0, 500)
  return error
}
