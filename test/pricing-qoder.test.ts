/**
 * 文件职责：真实倍率提取器的纯解析、NODE_OPTIONS 合并、与 fake CLI 的捕获集成、失败/超时降级。
 * 上游：node:test / Bun test。
 * 下游：src/pricing-qoder.mjs、test/fixtures/fake-qoder.mjs；不联网、不调用模型。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  PRICING_SOURCE,
  buildNodeOptions,
  extractPricing,
  parsePricingCaptures,
} from "../src/pricing-qoder.mjs"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))
const FIXED_MS = Date.parse("2026-11-11T10:00:00.000Z")
const FIXED_ISO = "2026-11-11T10:00:00.000Z"

const CATALOG = [
  {
    display_name: "Qwen3.8-Max",
    key: "qmodel_38max",
    price_factor: 0.5,
    original_price_factor: 0.5,
    promotion: {
      active: false,
      discount_factor: 0.4,
      before_promotion_price_factor: 0.5,
      window_start: "22:00",
      window_end: "08:00",
      timezone: "Asia/Shanghai",
      badge: { zh: "错峰 4 折", en: "Off-peak 40% off" },
      description: { zh: "错峰时段4折优惠", en: "40% off during off-peak" },
    },
  },
  { display_name: "Auto", key: "auto", price_factor: 0.5 },
]

test("buildNodeOptions appends the capture hook without dropping existing options", () => {
  assert.equal(buildNodeOptions(undefined, "file:///hook.mjs"), "--import=file:///hook.mjs")
  assert.equal(buildNodeOptions("", "file:///hook.mjs"), "--import=file:///hook.mjs")
  assert.equal(
    buildNodeOptions("  --no-warnings  ", "file:///hook.mjs"),
    "--no-warnings --import=file:///hook.mjs",
  )
})

test("parsePricingCaptures maps the plaintext catalog into the pricing contract", () => {
  const snapshot = parsePricingCaptures([CATALOG], FIXED_ISO) as any
  assert.equal(snapshot.fetchedAt, FIXED_ISO)
  assert.equal(snapshot.source, PRICING_SOURCE)
  assert.deepEqual(snapshot.models, [
    {
      modelKey: "Qwen3.8-Max",
      qoderKey: "qmodel_38max",
      priceFactor: 0.5,
      originalPriceFactor: 0.5,
      promotion: {
        active: false,
        discountFactor: 0.4,
        beforePromotionPriceFactor: 0.5,
        windowStart: "22:00",
        windowEnd: "08:00",
        timezone: "Asia/Shanghai",
        badge: "错峰 4 折",
        description: "错峰时段4折优惠",
      },
    },
    { modelKey: "Auto", qoderKey: "auto", priceFactor: 0.5 },
  ])
})

test("parsePricingCaptures accepts the scene assistant catalog and English labels", () => {
  const catalog = [
    {
      display_name: "Qwen3.8-Max",
      key: "qmodel_38max",
      price_factor: 0.4,
      promotion: { active: true, window_end: "08:00", timezone: "Asia/Shanghai", badge: { en: "Off-peak" } },
    },
  ]
  const snapshot = parsePricingCaptures([{ assistant: catalog }], FIXED_ISO) as any
  assert.equal(snapshot.models[0].promotion.badge, "Off-peak")
  assert.equal(snapshot.models[0].promotion.active, true)
})

test("parsePricingCaptures rejects empty, malformed or partially invalid catalogs", () => {
  assert.equal(parsePricingCaptures([], FIXED_ISO), null)
  assert.equal(parsePricingCaptures([{ assistant: [] }], FIXED_ISO), null)
  assert.equal(parsePricingCaptures([[{ display_name: "X", price_factor: "0.5" }]], FIXED_ISO), null)
  assert.equal(parsePricingCaptures([[{ key: "x", price_factor: 0.5 }]], FIXED_ISO), null)
  assert.equal(parsePricingCaptures([[{ display_name: " ", price_factor: 0.5 }]], FIXED_ISO), null)
  assert.equal(parsePricingCaptures([{ unrelated: true }], FIXED_ISO), null)
  assert.equal(
    parsePricingCaptures([[{ display_name: "Good", price_factor: 0.5 }, { display_name: "Bad" }]], FIXED_ISO),
    null,
  )
})

test("extractPricing captures the decrypted catalog through the injected hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-pricing-test-"))
  const catalogFile = join(dir, "catalog.json")
  const recordFile = join(dir, "list-models.jsonl")
  writeFileSync(catalogFile, JSON.stringify(CATALOG))
  try {
    const snapshot = (await extractPricing({
      cliPath: FAKE_CLI,
      env: {
        ...process.env,
        FAKE_QODER_PRICING: catalogFile,
        FAKE_QODER_LIST_RECORD: recordFile,
        NODE_OPTIONS: "--no-warnings",
      },
      timeoutMs: 20_000,
      now: () => FIXED_MS,
    })) as any

    assert.ok(snapshot)
    assert.equal(snapshot.fetchedAt, FIXED_ISO)
    assert.equal(snapshot.models[0].modelKey, "Qwen3.8-Max")
    assert.equal(snapshot.models[0].qoderKey, "qmodel_38max")

    const call = JSON.parse(readFileSync(recordFile, "utf8").trim())
    assert.deepEqual(call.argv, ["--list-models"])
    assert.match(call.nodeOptions, /--no-warnings/)
    assert.match(call.nodeOptions, /--import=file:\/\//)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("extractPricing returns null when the CLI cannot start", async () => {
  const snapshot = await extractPricing({
    cliPath: join(tmpdir(), "definitely-missing-qoder-cli"),
    timeoutMs: 2_000,
  })
  assert.equal(snapshot, null)
})

test("extractPricing returns null when --list-models fails", async () => {
  const snapshot = await extractPricing({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_QODER_LIST_EXIT: "3" },
    timeoutMs: 20_000,
  })
  assert.equal(snapshot, null)
})

test("extractPricing returns null when no pricing capture was produced", async () => {
  const snapshot = await extractPricing({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_QODER_PRICING: "" },
    timeoutMs: 20_000,
  })
  assert.equal(snapshot, null)
})

test("extractPricing kills the CLI tree and returns null on timeout", async () => {
  const started = Date.now()
  const snapshot = await extractPricing({
    cliPath: FAKE_CLI,
    env: { ...process.env, FAKE_QODER_DISCOVERY_DELAY_MS: "5000" },
    timeoutMs: 150,
  })
  assert.equal(snapshot, null)
  assert.ok(Date.now() - started < 3_000)
})
