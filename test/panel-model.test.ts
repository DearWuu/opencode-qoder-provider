/**
 * 文件职责：Credits 面板控制器的取数、手动刷新（并发、防重复、失败保留旧值）、折叠与订阅通知测试。
 * 上游：node:test / Bun test。
 * 下游：src/panel-model.mjs；全部取数函数为 fixture，不联网、不启动 CLI、不调用模型。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { createCreditsPanelController } from "../src/panel-model.mjs"

const NOW_MS = Date.parse("2026-11-11T10:00:00.000Z")

const STATS = { todayCredits: 12.34 }
const QUOTA = { available: true, used: 10, total: 100, percentage: 10, remaining: 90, expiresAt: "2026-11-20T00:00:00.000Z" }
const PRICING = {
  models: [{ modelKey: "Auto", priceFactor: 0.5 }],
  fetchedAt: "2026-11-11T10:00:00.000Z",
  source: "fixture",
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createController(overrides: Record<string, any> = {}) {
  const calls: { stats: number; quota: any[]; pricing: any[] } = { stats: 0, quota: [], pricing: [] }
  const controller = createCreditsPanelController({
    fetchStats: async () => {
      calls.stats += 1
      return STATS
    },
    fetchQuota: async (input: any) => {
      calls.quota.push(input)
      return QUOTA
    },
    fetchPricing: async (input: any) => {
      calls.pricing.push(input)
      return PRICING
    },
    now: () => NOW_MS,
    ...overrides,
  })
  return { controller, calls }
}

test("load reads stats, quota and pricing once and stamps nowMs", async () => {
  const { controller, calls } = createController()
  await controller.load()
  assert.equal(calls.stats, 1)
  assert.deepEqual(calls.quota, [{ refresh: false }])
  assert.deepEqual(calls.pricing, [{ refresh: false }])
  const state = controller.getState() as any
  assert.equal(state.stats, STATS)
  assert.equal(state.quota, QUOTA)
  assert.equal(state.pricing, PRICING)
  assert.equal(state.error, undefined)
  assert.equal(state.quotaError, undefined)
  assert.equal(state.nowMs, NOW_MS)
  assert.equal(state.refreshing, false)
  assert.equal(state.collapsed, false)
})

test("refresh forces quota and pricing together without touching stats", async () => {
  const { controller, calls } = createController()
  await controller.load()
  const ok = await controller.refresh()
  assert.equal(ok, true)
  assert.equal(calls.stats, 1)
  assert.deepEqual(calls.quota, [{ refresh: false }, { refresh: true }])
  assert.deepEqual(calls.pricing, [{ refresh: false }, { refresh: true }])
  assert.equal((controller.getState() as any).refreshing, false)
})

test("a second click while refreshing is ignored and does not issue extra requests", async () => {
  const quota = deferred<any>()
  const pricing = deferred<any>()
  let quotaCalls = 0
  let pricingCalls = 0
  const { controller } = createController({
    fetchQuota: async () => {
      quotaCalls += 1
      if (quotaCalls === 1) return QUOTA
      return quota.promise
    },
    fetchPricing: async () => {
      pricingCalls += 1
      if (pricingCalls === 1) return PRICING
      return pricing.promise
    },
  })
  await controller.load()

  const first = controller.refresh()
  assert.equal((controller.getState() as any).refreshing, true)
  const second = await controller.refresh()
  assert.equal(second, false)
  assert.equal(quotaCalls, 2)
  assert.equal(pricingCalls, 2)

  pricing.resolve(PRICING)
  quota.resolve(QUOTA)
  assert.equal(await first, true)
  assert.equal((controller.getState() as any).refreshing, false)
})

test("a failed refresh keeps the previous quota and pricing and hides the error", async () => {
  let failing = false
  const { controller } = createController({
    fetchQuota: async () => {
      if (failing) throw new Error("quota source down")
      return QUOTA
    },
    fetchPricing: async () => {
      if (failing) throw new Error("pricing source down")
      return PRICING
    },
  })
  await controller.load()
  failing = true
  const ok = await controller.refresh()
  assert.equal(ok, true)
  const state = controller.getState() as any
  assert.equal(state.quota, QUOTA)
  assert.equal(state.pricing, PRICING)
  assert.equal(state.quotaError, undefined)
  assert.equal(state.refreshing, false)
})

test("a failed refresh before any quota exists keeps the existing error state", async () => {
  const { controller } = createController({
    fetchQuota: async () => {
      throw new Error("quota source down")
    },
  })
  await controller.refresh()
  const state = controller.getState() as any
  assert.equal(state.quota, undefined)
  assert.equal(state.quotaError, "quota source down")
  assert.equal(state.refreshing, false)
})

test("togglePricing flips the in-memory collapsed flag and notifies subscribers", async () => {
  const { controller } = createController()
  let notifications = 0
  const unsubscribe = controller.subscribe(() => {
    notifications += 1
  })
  assert.equal((controller.getState() as any).collapsed, false)
  controller.togglePricing()
  assert.equal((controller.getState() as any).collapsed, true)
  controller.togglePricing()
  assert.equal((controller.getState() as any).collapsed, false)
  assert.equal(notifications, 2)
  unsubscribe()
  controller.togglePricing()
  assert.equal(notifications, 2)
})
