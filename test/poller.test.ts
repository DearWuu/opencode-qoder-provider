import { test } from "node:test"
import assert from "node:assert/strict"

import { STATS_POLL_INTERVAL_MS, createStatsPoller } from "../src/poller.mjs"

interface FakeTimers {
  scheduled: Array<{ id: number; fn: () => void; ms: number }>
  cleared: number[]
  setTimer: (fn: () => void, ms: number) => number
  clearTimer: (id: number) => void
  advance: (ms: number) => Promise<void>
}

function createFakeTimers(): FakeTimers {
  let nextId = 1
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const cleared: number[] = []
  return {
    get scheduled() {
      return [...timers.entries()].map(([id, t]) => ({ id, ...t }))
    },
    cleared,
    setTimer: (fn, ms) => {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clearTimer: (id) => {
      cleared.push(id)
      timers.delete(id)
    },
    advance: async (ms: number) => {
      for (const [id, t] of [...timers]) {
        if (t.ms <= ms) {
          timers.delete(id)
          t.fn()
          await flush()
        }
      }
    },
  }
}

/** 让已 await 的微任务（fetch 的 resolve）跑完 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

test("the first fetch starts immediately and is followed by interval refreshes", async () => {
  const timers = createFakeTimers()
  let calls = 0
  const poller = createStatsPoller({ fetch: async () => { calls += 1 }, setTimer: timers.setTimer, clearTimer: timers.clearTimer })

  poller.start()
  await flush()
  assert.equal(calls, 1)
  assert.equal(timers.scheduled.length, 1)
  assert.equal(timers.scheduled[0].ms, STATS_POLL_INTERVAL_MS)
  assert.equal(STATS_POLL_INTERVAL_MS, 15_000)

  await timers.advance(14_000)
  assert.equal(calls, 1)

  await timers.advance(15_000)
  assert.equal(calls, 2)
  assert.equal(timers.scheduled.length, 1, "each completion schedules exactly one follow-up")

  await timers.advance(15_000)
  assert.equal(calls, 3)
  poller.stop()
})

test("a rejecting fetch keeps the schedule alive", async () => {
  const timers = createFakeTimers()
  let calls = 0
  const poller = createStatsPoller({
    fetch: async () => {
      calls += 1
      if (calls === 1) throw new Error("rpc down")
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  poller.start()
  await flush()
  assert.equal(calls, 1)
  assert.equal(timers.scheduled.length, 1, "failure must still schedule the next poll")

  await timers.advance(15_000)
  assert.equal(calls, 2)
  poller.stop()
})

test("stop clears the pending timer and later advances do nothing", async () => {
  const timers = createFakeTimers()
  let calls = 0
  const poller = createStatsPoller({ fetch: async () => { calls += 1 }, setTimer: timers.setTimer, clearTimer: timers.clearTimer })

  poller.start()
  await flush()
  const pending = timers.scheduled[0]
  poller.stop()
  assert.deepEqual(timers.cleared, [pending.id])
  assert.equal(timers.scheduled.length, 0)

  await timers.advance(60_000)
  assert.equal(calls, 1)

  poller.stop()
  assert.equal(timers.cleared.length, 1, "stop is idempotent")
})

test("a completion after stop does not reschedule", async () => {
  const timers = createFakeTimers()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const poller = createStatsPoller({
    fetch: async () => {
      await gate
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })

  poller.start()
  await flush()
  assert.equal(timers.scheduled.length, 0, "the first poll has not completed yet")

  poller.stop()
  release()
  await flush()
  assert.equal(timers.scheduled.length, 0, "a stopped poller must not schedule again")
})
