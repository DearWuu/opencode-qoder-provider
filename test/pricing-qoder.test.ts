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
  PRICING_MAX_ATTEMPTS,
  PRICING_RETRY_BUDGET_MS,
  PRICING_RETRY_DELAY_MS,
  PRICING_SOURCE,
  buildNodeOptions,
  extractPricing,
  fetchPricingFromQoder,
  parsePricingCaptures,
  pricingSourceLabel,
  withColdStartRetry,
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

test("the pricing source names the CLI that was actually used", () => {
  assert.equal(pricingSourceLabel("qoderclicn"), "qoderclicn --list-models + JSON.parse capture hook (catalog plaintext)")
  assert.equal(pricingSourceLabel("/root/.nvm/bin/qodercli"), "qodercli --list-models + JSON.parse capture hook (catalog plaintext)")
  assert.equal(pricingSourceLabel("/plugin/bundle/qoderclicn.js"), "qoderclicn --list-models + JSON.parse capture hook (catalog plaintext)")
  assert.equal(pricingSourceLabel(""), PRICING_SOURCE)
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

test("withColdStartRetry stops at the bounded attempt count and delay defaults", async () => {
  assert.equal(PRICING_MAX_ATTEMPTS, 3)
  assert.equal(PRICING_RETRY_DELAY_MS, 1_500)
  assert.equal(PRICING_RETRY_BUDGET_MS, 60_000)

  let calls = 0
  const delays: number[] = []
  const snapshot = await withColdStartRetry(
    async () => {
      calls += 1
      return calls === 2 ? { models: [{ modelKey: "Auto", priceFactor: 1 }] } : null
    },
    { sleep: async (ms) => void delays.push(ms), now: () => 0 },
  )

  assert.deepEqual(snapshot, { models: [{ modelKey: "Auto", priceFactor: 1 }] })
  assert.equal(calls, 2)
  assert.deepEqual(delays, [PRICING_RETRY_DELAY_MS])
})

test("withColdStartRetry returns null once every attempt fails", async () => {
  let calls = 0
  const delays: number[] = []
  const snapshot = await withColdStartRetry(
    async () => {
      calls += 1
      return null
    },
    { sleep: async (ms) => void delays.push(ms), now: () => 0 },
  )

  assert.equal(snapshot, null)
  assert.equal(calls, PRICING_MAX_ATTEMPTS)
  assert.deepEqual(delays, [PRICING_RETRY_DELAY_MS, PRICING_RETRY_DELAY_MS])
})

test("withColdStartRetry never retries a successful attempt", async () => {
  let calls = 0
  const delays: number[] = []
  const value = { models: [{ modelKey: "Auto", priceFactor: 1 }] }
  const snapshot = await withColdStartRetry(
    async () => {
      calls += 1
      return value
    },
    { sleep: async (ms) => void delays.push(ms), now: () => 0 },
  )

  assert.equal(snapshot, value)
  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

test("withColdStartRetry gives up when the remaining budget cannot fit another wait", async () => {
  let calls = 0
  const delays: number[] = []
  const snapshot = await withColdStartRetry(
    async () => {
      calls += 1
      return null
    },
    { retryBudgetMs: PRICING_RETRY_DELAY_MS, sleep: async (ms) => void delays.push(ms), now: () => 0 },
  )

  assert.equal(snapshot, null)
  assert.equal(calls, 1)
  assert.deepEqual(delays, [])
})

test("fetchPricingFromQoder retries the first spawn that produced no catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-pricing-retry-"))
  const catalogFile = join(dir, "catalog.json")
  const recordFile = join(dir, "list-models.jsonl")
  writeFileSync(catalogFile, JSON.stringify(CATALOG))
  // 模拟冷启动首拍：CLI 非零退出，第二次才正常打印目录。
  const env: Record<string, string | undefined> = {
    ...process.env,
    FAKE_QODER_PRICING: catalogFile,
    FAKE_QODER_LIST_RECORD: recordFile,
    FAKE_QODER_LIST_EXIT: "3",
  }
  try {
    const snapshot = (await fetchPricingFromQoder({
      cliPath: FAKE_CLI,
      env,
      timeoutMs: 20_000,
      now: () => FIXED_MS,
      sleep: async () => {
        delete env.FAKE_QODER_LIST_EXIT
      },
    })) as any

    assert.ok(snapshot)
    assert.equal(snapshot.fetchedAt, FIXED_ISO)
    assert.equal(snapshot.models[0].modelKey, "Qwen3.8-Max")
    const calls = readFileSync(recordFile, "utf8").trim().split("\n")
    assert.equal(calls.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fetchPricingFromQoder exhausts its retries and degrades to null honestly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-pricing-exhausted-"))
  const recordFile = join(dir, "list-models.jsonl")
  try {
    const snapshot = await fetchPricingFromQoder({
      cliPath: FAKE_CLI,
      env: {
        ...process.env,
        FAKE_QODER_PRICING: "",
        FAKE_QODER_LIST_RECORD: recordFile,
        FAKE_QODER_LIST_EXIT: "3",
      },
      timeoutMs: 20_000,
      retryDelayMs: 0,
      sleep: async () => {},
    })

    assert.equal(snapshot, null)
    const calls = readFileSync(recordFile, "utf8").trim().split("\n")
    assert.equal(calls.length, PRICING_MAX_ATTEMPTS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("fetchPricingFromQoder spawns the CLI exactly once on the happy path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qoder-pricing-once-"))
  const catalogFile = join(dir, "catalog.json")
  const recordFile = join(dir, "list-models.jsonl")
  writeFileSync(catalogFile, JSON.stringify(CATALOG))
  try {
    const snapshot = (await fetchPricingFromQoder({
      cliPath: FAKE_CLI,
      env: {
        ...process.env,
        FAKE_QODER_PRICING: catalogFile,
        FAKE_QODER_LIST_RECORD: recordFile,
      },
      timeoutMs: 20_000,
      now: () => FIXED_MS,
    })) as any

    assert.ok(snapshot)
    assert.equal(snapshot.models.length, CATALOG.length)
    const calls = readFileSync(recordFile, "utf8").trim().split("\n")
    assert.equal(calls.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
