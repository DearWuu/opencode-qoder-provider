/**
 * 文件职责：官方 `/usage` 录制输出解析、额度 TTL 缓存、单飞、错误降级与 status 文案测试。
 * 上游：node:test / Bun test。
 * 下游：src/quota.mjs；不启动真实 CLI、不发送模型调用。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { QUOTA_SOURCE, createQuotaStore, formatQuotaStatus, parseOfficialQuota } from "../src/quota.mjs"

const RECORDED = readFileSync(fileURLToPath(new URL("./fixtures/official-usage.txt", import.meta.url)), "utf8")
const NOW = new Date("2026-11-10T10:00:00.000Z")

test("recorded official usage yields the real org package and expiry", () => {
  const quota = parseOfficialQuota(RECORDED, { now: NOW })
  assert.equal(quota.available, true)
  assert.equal(quota.source, QUOTA_SOURCE)
  assert.equal(quota.used, 6872)
  assert.equal(quota.total, 10000)
  assert.equal(quota.remaining, 3128)
  assert.equal(quota.percentage, 69)
  assert.equal(quota.expiresAt, "2026-11-19T16:00:00.000Z")
  assert.equal(quota.fetchedAt, NOW.toISOString())
  assert.equal(quota.error, "")
})

test("ANSI sequences and terminal whitespace do not corrupt official values", () => {
  const quota = parseOfficialQuota(`\x1b[2J${RECORDED.replace("OrgResourcePackage:6872/10000", "Org Resource Package: 6,872 / 10,000")}`, { now: NOW })
  assert.equal(quota.available, true)
  assert.equal(quota.used, 6872)
  assert.equal(quota.total, 10000)
})

test("missing expiry or credit fields returns unavailable rather than estimates", () => {
  for (const output of [
    RECORDED.replace(/PlanExpiresAt:.*\n/, ""),
    RECORDED.replace(/OrgResourcePackage:.*\n/, ""),
    "QoderCNPlan:Enterprise\nPlanCreditsUsed:N/A\nAdd-onCreditsUsed:N/A",
  ]) {
    const quota = parseOfficialQuota(output, { now: NOW })
    assert.equal(quota.available, false)
    assert.equal(quota.used, 0)
    assert.match(quota.error, /did not include|missing|unavailable/i)
  }
})

test("multiple official detail lines are never summed without an official total", () => {
  const output = RECORDED.replace("PlanCreditsUsed:N/A", "PlanCreditsUsed:10/100")
  const quota = parseOfficialQuota(output, { now: NOW })
  assert.equal(quota.available, false)
  assert.equal(quota.total, 0)
})

test("inconsistent credit values return unavailable", () => {
  const quota = parseOfficialQuota(RECORDED.replace("6872/10000", "10001/10000"), { now: NOW })
  assert.equal(quota.available, false)
  assert.match(quota.error, /inconsistent/)
})

test("quota reads are single-flight and cached in memory for five minutes", async () => {
  let nowMs = NOW.getTime()
  let calls = 0
  let release!: (value: string) => void
  const pending = new Promise<string>((resolve) => { release = resolve })
  const store = createQuotaStore({
    cliPath: "fake-qoder",
    now: () => nowMs,
    readUsage: () => {
      calls += 1
      return pending
    },
  })

  const first = store.read()
  const concurrent = store.read({ refresh: true })
  assert.equal(calls, 1)
  release(RECORDED)
  const [a, b] = await Promise.all([first, concurrent])
  assert.equal(a.available, true)
  assert.equal(b.available, true)
  assert.equal(a.cached, false)
  assert.equal(calls, 1)

  const cached = await store.read()
  assert.equal(cached.cached, true)
  assert.equal(calls, 1)
  nowMs += 5 * 60 * 1000 - 1
  await store.read()
  assert.equal(calls, 1)
  nowMs += 1
  await store.read()
  assert.equal(calls, 2)
  await store.read({ refresh: true })
  assert.equal(calls, 3)
  store.dispose()
})

test("quota helper failures become unavailable results and are cached without throwing", async () => {
  let calls = 0
  const store = createQuotaStore({
    cliPath: "fake-qoder",
    now: () => NOW.getTime(),
    readUsage: async () => {
      calls += 1
      throw new Error("pty unavailable")
    },
  })
  const quota = await store.read()
  assert.equal(quota.available, false)
  assert.equal(quota.error, "pty unavailable")
  const again = await store.read()
  assert.equal(again.cached, true)
  assert.equal(calls, 1)
  const status = formatQuotaStatus(quota)
  assert.match(status, /Quota: unavailable — pty unavailable/)
  assert.match(status, /Quota source: Qoder CLI \/usage/)
  store.dispose()
})
