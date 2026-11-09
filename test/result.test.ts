import { test } from "node:test"
import assert from "node:assert/strict"

import { buildProviderMetadata, detectFallback, summarizeModelUsage } from "../src/result.mjs"

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
