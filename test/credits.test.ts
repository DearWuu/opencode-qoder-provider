import { test } from "node:test"
import assert from "node:assert/strict"

import { creditsPanelLines, formatCredits, formatRelativeTime } from "../src/credits.mjs"

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
const NOW_MS = Date.parse("2026-11-10T10:00:00.000Z")

test("formatCredits keeps at most two decimals and drops trailing zeros", () => {
  assert.equal(formatCredits(0), "0")
  assert.equal(formatCredits(10), "10")
  assert.equal(formatCredits(1.5), "1.5")
  assert.equal(formatCredits(1.234), "1.23")
  assert.equal(formatCredits(12.345), "12.35")
  assert.equal(formatCredits(0.004), "0")
  assert.equal(formatCredits(Number.NaN), "0")
  assert.equal(formatCredits(undefined), "0")
  assert.equal(formatCredits("1"), "0")
})

test("formatRelativeTime renders compact ages", () => {
  assert.equal(formatRelativeTime("", NOW_MS), "no calls")
  assert.equal(formatRelativeTime("garbage", NOW_MS), "no calls")
  assert.equal(formatRelativeTime("2026-11-10T09:59:40.000Z", NOW_MS), "just now")
  // Future timestamps never render as a negative age.
  assert.equal(formatRelativeTime("2026-11-10T10:59:00.000Z", NOW_MS), "just now")
  assert.equal(formatRelativeTime("2026-11-10T09:57:00.000Z", NOW_MS), "3m ago")
  assert.equal(formatRelativeTime("2026-11-10T08:00:00.000Z", NOW_MS), "2h ago")
  assert.equal(formatRelativeTime("2026-11-07T10:00:00.000Z", NOW_MS), "3d ago")
})

test("the panel renders four data lines from stats", () => {
  const lines = creditsPanelLines({ stats: STATS, error: undefined, nowMs: NOW_MS })
  assert.deepEqual(lines, [
    { tone: "muted", text: "Spent 12.5 · 56 calls" },
    { tone: "muted", text: "Today 1.23 · 4 calls" },
    { tone: "muted", text: "Last Qwen3.8-Flash 0.42 · 3m ago" },
    { tone: "muted", text: "12 models · auth ok" },
  ])
})

test("a failed last call highlights the Last line", () => {
  const lines = creditsPanelLines({ stats: { ...STATS, lastError: true }, error: undefined, nowMs: NOW_MS })
  assert.equal(lines[2].tone, "warning")
  assert.match(lines[2].text, /^Last Qwen3\.8-Flash/)
})

test("a failed auth shows on the model line", () => {
  const lines = creditsPanelLines({ stats: { ...STATS, authenticated: false }, error: undefined, nowMs: NOW_MS })
  assert.equal(lines[3].text, "12 models · auth error")
})

test("without calls the Last line says so instead of showing zeros", () => {
  const lines = creditsPanelLines({
    stats: { ...STATS, totalCalls: 0, totalCredits: 0, todayCalls: 0, todayCredits: 0, lastModel: "", lastCredits: 0, lastAt: "" },
    error: undefined,
    nowMs: NOW_MS,
  })
  assert.equal(lines[0].text, "Spent 0 · 0 calls")
  assert.equal(lines[1].text, "Today 0 · 0 calls")
  assert.equal(lines[2].text, "Last no calls yet")
})

test("a failed poll collapses the panel into one muted error line", () => {
  const lines = creditsPanelLines({ stats: STATS, error: "rpc unavailable", nowMs: NOW_MS })
  assert.deepEqual(lines, [{ tone: "muted", text: "stats unavailable: rpc unavailable" }])
})

test("before the first result the panel shows a loading line", () => {
  const lines = creditsPanelLines({ stats: undefined, error: undefined, nowMs: NOW_MS })
  assert.deepEqual(lines, [{ tone: "muted", text: "loading credits stats..." }])
})
