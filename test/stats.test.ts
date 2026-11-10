import { test } from "node:test"
import assert from "node:assert/strict"

import { computeQoderStats } from "../src/stats.mjs"

const INFO = { provider: "qoder", models: 12, authenticated: true, permissionMode: "default", cliVersion: "1.1.85" }

/** noon of a fixed local day so "today" works in every timezone. */
function dayAt(now: Date, offsetDays: number, hour = 12): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays, hour).toISOString()
}

const NOW = new Date(2026, 10, 10, 9, 0, 0)

test("sums calls and credits across the whole log", () => {
  const entries = [
    { ts: dayAt(NOW, -3), model: "auto", credits: 1.5 },
    { ts: dayAt(NOW, -1), model: "fast", credits: 2.25 },
    { ts: dayAt(NOW, 0), model: "auto", credits: 0.5 },
  ]
  const stats = computeQoderStats(entries, { ...INFO, now: NOW })
  assert.equal(stats.totalCalls, 3)
  assert.equal(stats.totalCredits, 4.25)
})

test("counts only the local calendar day for today", () => {
  const entries = [
    { ts: dayAt(NOW, -1, 23), model: "auto", credits: 9 },
    { ts: dayAt(NOW, 0, 0), model: "auto", credits: 1 },
    { ts: dayAt(NOW, 0, 8), model: "fast", credits: 2 },
  ]
  const stats = computeQoderStats(entries, { ...INFO, now: NOW })
  assert.equal(stats.todayCalls, 2)
  assert.equal(stats.todayCredits, 3)
})

test("entries without usable credits still count as calls", () => {
  const entries = [
    { ts: dayAt(NOW, 0), model: "auto" },
    { ts: dayAt(NOW, 0), model: "auto", credits: Number.NaN },
    { ts: "not-a-date", model: "auto", credits: 3 },
  ]
  const stats = computeQoderStats(entries, { ...INFO, now: NOW })
  assert.equal(stats.totalCalls, 3)
  assert.equal(stats.totalCredits, 3)
  // The malformed timestamp is neither today nor usable as lastAt input, but
  // the last entry still defines the "last" fields.
  assert.equal(stats.todayCalls, 2)
  assert.equal(stats.todayCredits, 0)
  assert.equal(stats.lastModel, "auto")
  assert.equal(stats.lastCredits, 3)
  assert.equal(stats.lastAt, "not-a-date")
})

test("reports the last entry for the last-call fields", () => {
  const entries = [
    { ts: dayAt(NOW, -1), model: "auto", credits: 1 },
    { ts: dayAt(NOW, 0), model: "Qwen3.8-Flash", credits: 0.4, isError: true },
  ]
  const stats = computeQoderStats(entries, { ...INFO, now: NOW })
  assert.equal(stats.lastModel, "Qwen3.8-Flash")
  assert.equal(stats.lastCredits, 0.4)
  assert.equal(stats.lastAt, dayAt(NOW, 0))
  assert.equal(stats.lastError, true)
})

test("an empty log yields zeros, not nulls", () => {
  const stats = computeQoderStats([], { provider: "qoder", models: 0, authenticated: false, permissionMode: "default" })
  assert.deepEqual(stats, {
    provider: "qoder",
    models: 0,
    authenticated: false,
    permissionMode: "default",
    cliVersion: "",
    totalCalls: 0,
    totalCredits: 0,
    todayCalls: 0,
    todayCredits: 0,
    lastModel: "",
    lastCredits: 0,
    lastAt: "",
    lastError: false,
  })
})

test("the last entry without model or credits still reports empty strings", () => {
  const stats = computeQoderStats([{ ts: dayAt(NOW, 0), isError: false }], { ...INFO, now: NOW })
  assert.equal(stats.lastModel, "")
  assert.equal(stats.lastCredits, 0)
  assert.equal(stats.lastError, false)
})
