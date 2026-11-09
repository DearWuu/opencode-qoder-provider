import { test } from "node:test"
import assert from "node:assert/strict"

import { buildProviderMetadata, buildUsage, detectFallback, summarizeModelUsage } from "../src/result.mjs"

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
