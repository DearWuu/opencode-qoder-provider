import { test } from "node:test"
import assert from "node:assert/strict"

import {
  buildGenerateResult,
  buildProviderMetadata,
  buildUsage,
  detectFallback,
  summarizeModelUsage,
  toUnifiedFinishReason,
} from "../src/result.mjs"

test("modelUsage keys stay separate from the requested actualModel", () => {
  const raw = {
    total_credits: 0.25,
    modelUsage: {
      auto: { credits: 0.25 },
    },
  }
  const summary = summarizeModelUsage(raw)
  assert.equal("actualModel" in summary, false)
  assert.equal(summary.usageModelKey, "auto")
  assert.deepEqual(summary.usageModelKeys, ["auto"])

  const metadata = buildProviderMetadata({ raw, requestedModel: "DeepSeek-Flash" })
  assert.equal(metadata.actualModel, "DeepSeek-Flash")
  assert.equal(metadata.modelFallback, false)
  assert.equal(metadata.usageModelKey, "auto")
  assert.deepEqual(metadata.usageModelKeys, ["auto"])
})

test("detectFallback does not infer a fallback without explicit stderr", () => {
  assert.deepEqual(detectFallback("DeepSeek-Flash", ""), {
    fellBack: false,
    actualModel: "DeepSeek-Flash",
  })
  assert.deepEqual(detectFallback("Fast", "usage accounting key: auto\n"), {
    fellBack: false,
    actualModel: "Fast",
  })
})

test("detectFallback recognizes a quoted falling-back message", () => {
  assert.deepEqual(
    detectFallback("efficient", 'Model "efficient" is unavailable, falling back to "auto".\n'),
    { fellBack: true, actualModel: "auto" },
  )
})

test("detectFallback recognizes an unquoted using-instead message", () => {
  assert.deepEqual(
    detectFallback("efficient", "Model efficient is unavailable, using auto instead.\n"),
    { fellBack: true, actualModel: "auto" },
  )
})

test("summarizeModelUsage reads usage.context_usage_ratio with a top-level fallback", () => {
  assert.equal(
    summarizeModelUsage({ usage: { context_usage_ratio: 0.034375 } }).contextUsageRatio,
    0.034375,
  )
  assert.equal(summarizeModelUsage({ context_usage_ratio: 0.5 }).contextUsageRatio, 0.5)
  assert.equal(summarizeModelUsage({ usage: { context_usage_ratio: 0 } }).contextUsageRatio, undefined)
  assert.equal(summarizeModelUsage({ usage: { context_usage_ratio: 1.5 } }).contextUsageRatio, undefined)
})

test("buildUsage keeps real non-zero token counters over the ratio approximation", () => {
  const raw = {
    usage: { input_tokens: 1234, output_tokens: 42, context_usage_ratio: 0.5 },
    modelUsage: { auto: { inputTokens: 1234, outputTokens: 42 } },
  }
  const usage = buildUsage(raw, { contextLimit: 200_000 })
  assert.equal(usage.inputTokens.total, 1234)
  assert.equal(usage.outputTokens.total, 42)
})

test("buildUsage approximates input tokens from the ratio when counters are zero", () => {
  const raw = {
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, context_usage_ratio: 0.034375 },
    modelUsage: { auto: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 } },
  }
  const usage = buildUsage(raw, { contextLimit: 200_000 })
  assert.equal(usage.inputTokens.total, 6875)
  assert.equal(usage.inputTokens.noCache, 6875)

  const metadata = buildProviderMetadata({ raw, requestedModel: "Auto", contextLimit: 200_000 })
  assert.equal(metadata.contextUsageRatio, 0.034375)
  assert.equal(metadata.approximatedContextTokens, true)
})

test("buildUsage without tokens and without a ratio stays at zero", () => {
  const raw = { usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: { auto: { inputTokens: 0 } } }
  const usage = buildUsage(raw, { contextLimit: 200_000 })
  assert.equal(usage.inputTokens.total, 0)

  const metadata = buildProviderMetadata({ raw, requestedModel: "Auto", contextLimit: 200_000 })
  assert.equal("contextUsageRatio" in metadata, false)
  assert.equal(metadata.approximatedContextTokens, false)
})

test("summarizeModelUsage picks the entry with credits or tokens over the first all-zero key", () => {
  // Real-world shape: Auto accounting emits an all-zero `auto` entry first,
  // the actual usage sits under `fast` with credits.
  const raw = {
    total_credits: 0.129,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      auto: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, credits: 0 },
      fast: { inputTokens: 9406, outputTokens: 119, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, credits: 0.129 },
    },
  }
  const summary = summarizeModelUsage(raw)
  assert.equal(summary.usageModelKey, "fast")
  assert.deepEqual(summary.usageModelKeys, ["auto", "fast"])
  assert.equal(summary.credits, 0.129)
  assert.equal(summary.inputTokens, 9406)
  assert.equal(summary.outputTokens, 119)

  const metadata = buildProviderMetadata({ raw, requestedModel: "Auto" })
  assert.equal(metadata.usageModelKey, "fast")
  assert.equal(metadata.modelCredits, 0.129)
})

test("summarizeModelUsage keeps the first key when no entry carries usage", () => {
  const raw = {
    modelUsage: {
      auto: { inputTokens: 0, outputTokens: 0, credits: 0 },
      fast: { inputTokens: 0, outputTokens: 0, credits: 0 },
    },
  }
  const summary = summarizeModelUsage(raw)
  assert.equal(summary.usageModelKey, "auto")
  assert.equal(summary.credits, 0)
})

test("summarizeModelUsage also selects an entry with only non-zero tokens", () => {
  const raw = {
    modelUsage: {
      auto: { inputTokens: 0, outputTokens: 0, credits: 0 },
      fast: { inputTokens: 12, outputTokens: 0, credits: 0 },
    },
  }
  assert.equal(summarizeModelUsage(raw).usageModelKey, "fast")
})

test("finishReason maps max_tokens and max-output-tokens to the unified length reason", () => {
  const result = buildGenerateResult({ raw: { is_error: false, result: "cut", stop_reason: "max_tokens" }, requestedModel: "Auto", contextLimit: 200_000 })
  assert.deepEqual(result.finishReason, { unified: "length", raw: "max_tokens" })

  const hyphenated = buildGenerateResult({ raw: { is_error: false, result: "cut", stop_reason: "max-output-tokens" }, requestedModel: "Auto", contextLimit: 200_000 })
  assert.deepEqual(hyphenated.finishReason, { unified: "length", raw: "max-output-tokens" })

  assert.equal(toUnifiedFinishReason({ is_error: false, stop_reason: "end_turn" }), "stop")
  assert.equal(toUnifiedFinishReason({ is_error: false }), "stop")
  assert.equal(toUnifiedFinishReason({ is_error: true, stop_reason: "max_tokens" }), "error")
})
