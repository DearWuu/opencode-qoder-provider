/**
 * 文件职责：Credits 面板的 Today、官方额度、到期天数与 unavailable/加载/错误行测试。
 * 上游：node:test / Bun test。
 * 下游：src/credits.mjs 纯格式化函数。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { creditsPanelLines, formatCredits, formatQuotaNumber, formatRelativeTime, panelFooterLines } from "../src/credits.mjs"

const STATS = {
  provider: "qoder",
  models: 12,
  authenticated: true,
  permissionMode: "default",
  cliVersion: "1.1.85",
  totalCalls: 56,
  totalCredits: 12.5,
  todayCalls: 4,
  todayCredits: 1.234,
  lastModel: "Qwen3.8-Flash",
  lastCredits: 0.42,
  lastAt: "2026-11-10T09:57:00.000Z",
  lastError: false,
}
const QUOTA = {
  available: true,
  source: "Qoder CLI /usage",
  used: 6872,
  total: 10000,
  remaining: 3128,
  percentage: 69,
  expiresAt: "2026-11-19T16:00:00.000Z",
  fetchedAt: "2026-11-10T10:00:00.000Z",
  cached: false,
  error: "",
}
const NOW_MS = Date.parse("2026-11-10T10:00:00.000Z")

test("Today credits always keeps two decimals", () => {
  assert.equal(formatCredits(0), "0.00")
  assert.equal(formatCredits(10), "10.00")
  assert.equal(formatCredits(1.5), "1.50")
  assert.equal(formatCredits(1.234), "1.23")
  assert.equal(formatCredits(12.345), "12.35")
  assert.equal(formatCredits(Number.NaN), "0.00")
  assert.equal(formatCredits(undefined), "0.00")
})

test("official quota numbers use thousands separators", () => {
  assert.equal(formatQuotaNumber(6872), "6,872")
  assert.equal(formatQuotaNumber(10000), "10,000")
  assert.equal(formatQuotaNumber(3128), "3,128")
})

test("formatRelativeTime renders compact ages", () => {
  assert.equal(formatRelativeTime("", NOW_MS), "no calls")
  assert.equal(formatRelativeTime("garbage", NOW_MS), "no calls")
  assert.equal(formatRelativeTime("2026-11-10T09:59:40.000Z", NOW_MS), "just now")
  assert.equal(formatRelativeTime("2026-11-10T09:57:00.000Z", NOW_MS), "3m ago")
  assert.equal(formatRelativeTime("2026-11-10T08:00:00.000Z", NOW_MS), "2h ago")
})

test("the panel renders Today and the two real official quota lines", () => {
  const lines = creditsPanelLines({ stats: STATS, quota: QUOTA, error: undefined, nowMs: NOW_MS })
  assert.deepEqual(lines, [
    { tone: "muted", text: "Today 1.23" },
    { tone: "muted", text: "6,872 / 10,000（已使用 69%）" },
    { tone: "muted", text: "剩余 3,128 · 距离重置还有 10 天" },
  ])
})

test("reset days round up and never become negative", () => {
  const future = { ...QUOTA, expiresAt: "2026-11-10T10:00:00.001Z" }
  const futureLines = creditsPanelLines({ stats: STATS, quota: future, error: undefined, nowMs: NOW_MS })
  assert.match(futureLines[2]!.text, /还有 1 天/)
  const past = { ...QUOTA, expiresAt: "2026-11-09T10:00:00.000Z" }
  const pastLines = creditsPanelLines({ stats: STATS, quota: past, error: undefined, nowMs: NOW_MS })
  assert.match(pastLines[2]!.text, /还有 0 天/)
})

test("unavailable quota stays concise and preserves local Today", () => {
  const quota = { ...QUOTA, available: false, used: 0, total: 0, remaining: 0, error: "not logged in" }
  const lines = creditsPanelLines({ stats: STATS, quota, error: undefined, nowMs: NOW_MS })
  assert.deepEqual(lines, [
    { tone: "muted", text: "Today 1.23" },
    { tone: "muted", text: "Quota unavailable" },
  ])
})

test("a quota transport failure also preserves Today without exposing a toast", () => {
  const lines = creditsPanelLines({ stats: STATS, quota: QUOTA, error: undefined, quotaError: "rpc unavailable", nowMs: NOW_MS })
  assert.deepEqual(lines.map((line) => line.text), ["Today 1.23", "Quota unavailable"])
})

test("a stats failure collapses the panel into one muted error line", () => {
  const lines = creditsPanelLines({ stats: STATS, quota: QUOTA, error: "rpc unavailable", nowMs: NOW_MS })
  assert.deepEqual(lines, [{ tone: "muted", text: "stats unavailable: rpc unavailable" }])
})

test("before the first results the panel shows loading lines", () => {
  assert.deepEqual(creditsPanelLines({ stats: undefined, quota: undefined, error: undefined, nowMs: NOW_MS }), [
    { tone: "muted", text: "loading credits stats..." },
  ])
  assert.deepEqual(creditsPanelLines({ stats: STATS, quota: undefined, error: undefined, nowMs: NOW_MS }), [
    { tone: "muted", text: "Today 1.23" },
    { tone: "muted", text: "Quota loading..." },
  ])
})

test("the footer offers an idle refresh action and shows progress while refreshing", () => {
  assert.deepEqual(panelFooterLines(), [{ tone: "muted", text: "⟳ 刷新", action: "refresh" }])
  assert.deepEqual(panelFooterLines({ refreshing: false }), [{ tone: "muted", text: "⟳ 刷新", action: "refresh" }])
  assert.deepEqual(panelFooterLines({ refreshing: true }), [{ tone: "muted", text: "刷新中…", action: "refresh" }])
})
