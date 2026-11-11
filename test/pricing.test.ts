/**
 * 文件职责：每日时段换算、每模型倍率快照的 TTL/单飞/失败保留、倍率与倒计时边界、促销态与面板/status 文案测试。
 * 上游：node:test / Bun test。
 * 下游：src/pricing.mjs；不联网、不启动真实 CLI、不调用模型。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  PRICING_TTL_MS,
  countdownText,
  createPricingStore,
  formatFactor,
  modelPricingLine,
  nextDailyWindow,
  pricingPanelLines,
  pricingStatusLine,
  promotionText,
} from "../src/pricing.mjs"

const NOW_MS = Date.parse("2026-11-11T10:00:00.000Z")
// 2026-11-12 07:30 Asia/Shanghai：距离 08:00 结束还有 30 分钟。
const ACTIVE_NOW_MS = Date.parse("2026-11-11T23:30:00.000Z")
// 2026-11-11 21:00 Asia/Shanghai：距离 22:00 开始还有 1 小时。
const UPCOMING_NOW_MS = Date.parse("2026-11-11T13:00:00.000Z")
const FETCHED_AT = "2026-11-11T10:00:00.000Z"

function snapshot(models: any[], overrides: Record<string, any> = {}) {
  return { models, fetchedAt: FETCHED_AT, source: "fixture", ...overrides }
}

function activeModel(overrides: Record<string, any> = {}) {
  return {
    modelKey: "GLM-5.3",
    priceFactor: 0.1,
    originalPriceFactor: 0.5,
    promotion: {
      active: true,
      discountFactor: 0.1,
      beforePromotionPriceFactor: 0.5,
      windowStart: "22:00",
      windowEnd: "08:00",
      timezone: "Asia/Shanghai",
      badge: "错峰 4 折",
      description: "错峰时段4折优惠",
    },
    ...overrides,
  }
}

function upcomingModel(promotion: Record<string, any> = {}) {
  return {
    modelKey: "GLM-5.3",
    priceFactor: 0.5,
    promotion: {
      active: false,
      discountFactor: 0.4,
      windowStart: "22:00",
      windowEnd: "08:00",
      timezone: "Asia/Shanghai",
      badge: "错峰 4 折",
      ...promotion,
    },
  }
}

test("formatFactor keeps two decimals and appends x", () => {
  assert.equal(formatFactor(0.1), "0.10x")
  assert.equal(formatFactor(1), "1.00x")
  assert.equal(formatFactor(0.456), "0.46x")
  assert.equal(formatFactor(undefined), "")
  assert.equal(formatFactor(Number.NaN), "")
})

test("countdownText switches buckets at one hour and one day", () => {
  assert.equal(countdownText("2026-11-11T10:59:00.000Z", NOW_MS), "59 分")
  assert.equal(countdownText("2026-11-11T11:00:00.000Z", NOW_MS), "1 小时 0 分")
  assert.equal(countdownText("2026-11-11T23:59:00.000Z", NOW_MS), "13 小时 59 分")
  assert.equal(countdownText("2026-11-12T10:00:00.000Z", NOW_MS), "1 天 0 小时")
  assert.equal(countdownText("2026-11-13T12:00:00.000Z", NOW_MS), "2 天 2 小时")
})

test("countdownText accepts absolute milliseconds and degrades without a valid target", () => {
  assert.equal(countdownText(Date.parse("2026-11-11T11:00:00.000Z"), NOW_MS), "1 小时 0 分")
  assert.equal(countdownText(undefined, NOW_MS), "")
  assert.equal(countdownText("", NOW_MS), "")
  assert.equal(countdownText("not-a-date", NOW_MS), "")
  assert.equal(countdownText(Number.NaN, NOW_MS), "")
  assert.equal(countdownText("2026-11-11T09:00:00.000Z", NOW_MS), "0 分")
})

test("nextDailyWindow finds the next boundary inside the active daily window", () => {
  assert.equal(
    nextDailyWindow("08:00", "Asia/Shanghai", ACTIVE_NOW_MS),
    Date.parse("2026-11-12T00:00:00.000Z"),
  )
})

test("nextDailyWindow finds a same-day boundary that is still ahead", () => {
  assert.equal(
    nextDailyWindow("22:00", "Asia/Shanghai", UPCOMING_NOW_MS),
    Date.parse("2026-11-11T14:00:00.000Z"),
  )
})

test("nextDailyWindow rolls crossing-midnight windows to the next day", () => {
  // 23:30 Asia/Shanghai：22:00 已经过去，下一次是次日 22:00；08:00 尚未到来，是次日 08:00。
  assert.equal(
    nextDailyWindow("22:00", "Asia/Shanghai", ACTIVE_NOW_MS),
    Date.parse("2026-11-12T14:00:00.000Z"),
  )
  assert.equal(
    nextDailyWindow("08:00", "Asia/Shanghai", ACTIVE_NOW_MS),
    Date.parse("2026-11-12T00:00:00.000Z"),
  )
})

test("nextDailyWindow does not depend on the server local timezone", () => {
  assert.equal(
    nextDailyWindow("22:00", "UTC", UPCOMING_NOW_MS),
    Date.parse("2026-11-11T22:00:00.000Z"),
  )
  assert.equal(
    nextDailyWindow("22:00", "Asia/Shanghai", UPCOMING_NOW_MS),
    Date.parse("2026-11-11T14:00:00.000Z"),
  )
})

test("nextDailyWindow treats an exactly matched wall time as already past", () => {
  assert.equal(
    nextDailyWindow("22:00", "Asia/Shanghai", Date.parse("2026-11-11T14:00:00.000Z")),
    Date.parse("2026-11-12T14:00:00.000Z"),
  )
})

test("nextDailyWindow rejects invalid times and timezones", () => {
  assert.equal(nextDailyWindow("25:00", "Asia/Shanghai", NOW_MS), undefined)
  assert.equal(nextDailyWindow("22:60", "Asia/Shanghai", NOW_MS), undefined)
  assert.equal(nextDailyWindow("abc", "Asia/Shanghai", NOW_MS), undefined)
  assert.equal(nextDailyWindow("22:00", "", NOW_MS), undefined)
  assert.equal(nextDailyWindow("22:00", "Not/AZone", NOW_MS), undefined)
  assert.equal(nextDailyWindow(undefined, "Asia/Shanghai", NOW_MS), undefined)
})

test("an active promotion counts down to the next daily window end and names the restore factor", () => {
  assert.equal(promotionText(activeModel(), ACTIVE_NOW_MS), "低峰 · 30 分后恢复 0.50x")
  const fallback = activeModel({
    promotion: { active: true, windowEnd: "08:00", timezone: "Asia/Shanghai" },
  })
  assert.equal(promotionText(fallback, ACTIVE_NOW_MS), "低峰 · 30 分后恢复 0.50x")
})

test("an upcoming promotion shows the badge verbatim without multiplying the discount", () => {
  assert.equal(promotionText(upcomingModel(), UPCOMING_NOW_MS), "1 小时 0 分后进入错峰 4 折")
  const text = promotionText(upcomingModel(), UPCOMING_NOW_MS)
  assert.equal(text.includes("0.40x"), false)
  assert.equal(
    promotionText(upcomingModel({ badge: undefined }), UPCOMING_NOW_MS),
    "1 小时 0 分后进入低峰折扣",
  )
})

test("a missing or invalid window only shows the current factor", () => {
  const noWindow = { modelKey: "GLM-5.3", priceFactor: 0.5, promotion: { active: true } }
  assert.equal(promotionText(noWindow, NOW_MS), "")
  assert.equal(modelPricingLine(noWindow, NOW_MS), "0.50x")

  const noTimezone = upcomingModel({ timezone: undefined })
  assert.equal(promotionText(noTimezone, UPCOMING_NOW_MS), "")
  assert.equal(modelPricingLine(noTimezone, UPCOMING_NOW_MS), "0.50x")

  const badTime = upcomingModel({ windowStart: "25:00" })
  assert.equal(promotionText(badTime, UPCOMING_NOW_MS), "")

  const activeWithoutRestore = {
    modelKey: "GLM-5.3",
    priceFactor: 0.5,
    promotion: { active: true, windowEnd: "08:00", timezone: "Asia/Shanghai" },
  }
  assert.equal(promotionText(activeWithoutRestore, ACTIVE_NOW_MS), "")
})

test("the panel hides the whole pricing section when data is missing or empty", () => {
  assert.deepEqual(pricingPanelLines({}), [])
  assert.deepEqual(pricingPanelLines({ pricing: null, nowMs: NOW_MS }), [])
  assert.deepEqual(pricingPanelLines({ pricing: snapshot([]), nowMs: NOW_MS }), [])
  assert.deepEqual(pricingPanelLines({ pricing: snapshot([{ modelKey: "" , priceFactor: 0.1 }]), nowMs: NOW_MS }), [])
})

test("the panel shows each model factor, the active countdown and the update time", () => {
  const lines = pricingPanelLines({ pricing: snapshot([activeModel(), { modelKey: "Auto", priceFactor: 1 }]), nowMs: ACTIVE_NOW_MS })
  assert.deepEqual(lines.slice(0, 3), [
    { tone: "base", text: "模型倍率" },
    { tone: "muted", text: "GLM-5.3 0.10x 低峰 · 30 分后恢复 0.50x" },
    { tone: "muted", text: "Auto 1.00x" },
  ])
  assert.equal(lines.length, 4)
  assert.match((lines[3] as any).text, /^\d{2}:\d{2} 更新$/)
})

test("the panel renders the upcoming low-peak state with its badge", () => {
  const lines = pricingPanelLines({ pricing: snapshot([upcomingModel()]), nowMs: UPCOMING_NOW_MS })
  assert.equal(lines[1]!.text, "GLM-5.3 0.50x 1 小时 0 分后进入错峰 4 折")
})

test("the panel omits the update line when fetchedAt is invalid", () => {
  const lines = pricingPanelLines({ pricing: snapshot([activeModel()], { fetchedAt: "garbage" }), nowMs: ACTIVE_NOW_MS })
  assert.equal(lines.length, 2)
  assert.equal(lines[1]!.text, "GLM-5.3 0.10x 低峰 · 30 分后恢复 0.50x")
})

test("the status summary reports an active or an upcoming daily window", () => {
  assert.equal(
    pricingStatusLine(snapshot([activeModel()]), ACTIVE_NOW_MS),
    "- Pricing: 低峰进行中，30 分后恢复 0.50x",
  )
  assert.equal(
    pricingStatusLine(snapshot([upcomingModel()]), UPCOMING_NOW_MS),
    "- Pricing: 1 小时 0 分后进入错峰 4 折",
  )
  assert.equal(pricingStatusLine(snapshot([{ modelKey: "Auto", priceFactor: 1 }]), NOW_MS), "- Pricing: 1 个模型，当前无低峰折扣")
  assert.equal(pricingStatusLine(null, NOW_MS), undefined)
  assert.equal(pricingStatusLine(snapshot([]), NOW_MS), undefined)
})

test("the pricing store serves a successful snapshot from cache for ten minutes", async () => {
  let nowMs = NOW_MS
  let calls = 0
  const first = snapshot([{ modelKey: "Auto", priceFactor: 1 }])
  const second = snapshot([{ modelKey: "Auto", priceFactor: 0.8 }], { fetchedAt: "2026-11-11T10:10:00.000Z" })
  const store = createPricingStore({
    now: () => nowMs,
    fetchPricing: async () => {
      calls += 1
      return calls === 1 ? first : second
    },
  })

  assert.equal(await store.read(), first)
  assert.equal(calls, 1)
  nowMs += PRICING_TTL_MS - 1
  assert.equal(await store.read(), first)
  assert.equal(calls, 1)
  nowMs += 1
  assert.equal(await store.read(), second)
  assert.equal(calls, 2)
  store.dispose()
})

test("concurrent pricing reads share a single fetch", async () => {
  let calls = 0
  let release!: (value: any) => void
  const pending = new Promise<any>((resolve) => {
    release = resolve
  })
  const store = createPricingStore({
    now: () => NOW_MS,
    fetchPricing: () => {
      calls += 1
      return pending
    },
  })

  const first = store.read()
  const concurrent = store.read({ refresh: true })
  assert.equal(calls, 1)
  const value = snapshot([{ modelKey: "Auto", priceFactor: 1 }])
  release(value)
  const [a, b] = await Promise.all([first, concurrent])
  assert.equal(a, value)
  assert.equal(b, value)
  assert.equal(calls, 1)
  store.dispose()
})

test("a failed fetch keeps the previous snapshot and its fetchedAt", async () => {
  let nowMs = NOW_MS
  let calls = 0
  let failing = false
  const old = snapshot([{ modelKey: "Auto", priceFactor: 1 }])
  const fresh = snapshot([{ modelKey: "Auto", priceFactor: 0.5 }], { fetchedAt: "2026-11-11T10:20:00.000Z" })
  const store = createPricingStore({
    now: () => nowMs,
    fetchPricing: async () => {
      calls += 1
      if (failing) throw new Error("pricing source down")
      return calls === 1 ? old : fresh
    },
  })

  assert.equal(await store.read(), old)
  nowMs += PRICING_TTL_MS
  failing = true
  assert.equal(await store.read(), old)
  assert.equal(calls, 2)
  const kept = (await store.read()) as any
  assert.equal(kept.fetchedAt, old.fetchedAt)
  failing = false
  assert.equal(await store.read(), fresh)
  assert.equal(calls, 4)
  store.dispose()
})

test("the default fetcher returns null instead of fabricating factors", async () => {
  const store = createPricingStore({ now: () => NOW_MS })
  assert.equal(await store.read(), null)
  store.dispose()
})

test("dispose stops new fetches and keeps the last snapshot readable", async () => {
  let calls = 0
  let nowMs = NOW_MS
  const value = snapshot([{ modelKey: "Auto", priceFactor: 1 }])
  const store = createPricingStore({
    now: () => nowMs,
    fetchPricing: async () => {
      calls += 1
      return value
    },
  })
  assert.equal(await store.read(), value)
  store.dispose()
  nowMs += PRICING_TTL_MS * 2
  assert.equal(await store.read({ refresh: true }), value)
  assert.equal(calls, 1)
})
