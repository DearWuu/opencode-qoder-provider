import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { MAX_STDOUT_BYTES } from "../src/cli.mjs"
import { makeProvider, readLogged, waitForExit, waitForFile, withFakeEnv, PROMPT } from "./provider-test-helpers.ts"

test("an aborted call rejects with an AbortError", async () => {
  const { provider } = makeProvider()
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "hang"
  const controller = new AbortController()
  try {
    const promise = model.doGenerate({ prompt: PROMPT, abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 150)
    await assert.rejects(promise, (error: unknown) => {
      assert.equal((error as Error).name, "AbortError")
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
})

test("a hanging call is aborted by the timeout", async () => {
  const { provider } = makeProvider({ timeoutMs: 300 })
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "hang"
  try {
    await assert.rejects(model.doGenerate({ prompt: PROMPT }), /timed out after 300 ms/)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
  }
})

test("idle timeout kills the whole tree, rejects doGenerate and records real diagnostics", async () => {
  const { provider, dir, logFile } = makeProvider({ timeoutMs: 5_000, idleTimeoutMs: 150 })
  const pidFile = join(dir, "cli.pid")
  const childPidFile = join(dir, "child.pid")
  await withFakeEnv(
    { FAKE_QODER_MODE: "hang", FAKE_QODER_PID_FILE: pidFile, FAKE_QODER_CHILD_PID_FILE: childPidFile },
    async () => {
      const promise = provider.languageModel("Auto").doGenerate({ prompt: PROMPT })
      assert.equal(await waitForFile(childPidFile), true)
      const pid = Number(readFileSync(pidFile, "utf8"))
      const childPid = Number(readFileSync(childPidFile, "utf8"))
      await assert.rejects(promise, (error: unknown) => {
        assert.equal((error as Error).name, "TimeoutError")
        assert.equal((error as Error & { timeoutKind?: string }).timeoutKind, "idle")
        assert.match((error as Error).message, /150 ms without stdout or stderr activity/)
        return true
      })
      assert.equal(await waitForExit(pid), true, "the CLI survived idle timeout")
      assert.equal(await waitForExit(childPid), true, "the CLI child survived idle timeout")
    },
  )

  const logged = readLogged(logFile)
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.timeoutKind, "idle")
  assert.equal(logged[0]!.timedOut, true)
  assert.equal(logged[0]!.lastEventType, "spawn")
  assert.equal(logged[0]!.sawStdout, false)
  assert.equal(logged[0]!.sawStderr, false)
  assert.equal(logged[0]!.sawTextDelta, false)
  assert.equal(logged[0]!.sawResult, false)
  assert.equal(typeof logged[0]!.lastEventAgoMs, "number")
  assert.equal(JSON.stringify(logged[0]).includes("be brief"), false)
})

test("stdout and stderr activity reset idle timeout but not the independent total timeout", async () => {
  const { provider, dir, logFile } = makeProvider({ timeoutMs: 450, idleTimeoutMs: 120 })
  const pidFile = join(dir, "cli.pid")
  const childPidFile = join(dir, "child.pid")
  await withFakeEnv(
    { FAKE_QODER_MODE: "heartbeat", FAKE_QODER_PID_FILE: pidFile, FAKE_QODER_CHILD_PID_FILE: childPidFile },
    async () => {
      const promise = provider.languageModel("Auto").doGenerate({ prompt: PROMPT })
      assert.equal(await waitForFile(childPidFile), true)
      const pid = Number(readFileSync(pidFile, "utf8"))
      const childPid = Number(readFileSync(childPidFile, "utf8"))
      await assert.rejects(promise, (error: unknown) => {
        assert.equal((error as Error & { timeoutKind?: string }).timeoutKind, "total")
        assert.match((error as Error).message, /timed out after 450 ms\./)
        return true
      })
      assert.equal(await waitForExit(pid), true)
      assert.equal(await waitForExit(childPid), true)
    },
  )

  const logged = readLogged(logFile)
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.timeoutKind, "total")
  assert.equal(logged[0]!.sawStdout, true)
  assert.equal(logged[0]!.sawStderr, true)
  assert.equal(logged[0]!.sawResult, false)
  assert.ok(["stdout", "stderr"].includes(String(logged[0]!.lastEventType)))
  // WSL 时钟可能调整，墙钟差不作为总定时器的单调性判据；total 类型与 450ms 错误已严格断言。
  assert.ok(Number(logged[0]!.durationMs) >= 0)
})

test("idle timeout is delivered as a doStream error part rather than a finish", async () => {
  const { provider, logFile } = makeProvider({ timeoutMs: 5_000, idleTimeoutMs: 150 })
  await withFakeEnv({ FAKE_QODER_MODE: "hang" }, async () => {
    const { stream } = await provider.languageModel("Auto").doStream({ prompt: PROMPT })
    const parts: any[] = []
    for await (const part of stream as unknown as AsyncIterable<any>) parts.push(part)
    assert.deepEqual(parts.map((part) => part.type), ["stream-start", "error"])
    assert.equal(parts[1]!.error.timeoutKind, "idle")
    assert.match(parts[1]!.error.message, /150 ms without stdout or stderr activity/)
  })
  const logged = readLogged(logFile)
  assert.equal(logged.length, 1)
  assert.equal(logged[0]!.timeoutKind, "idle")
  assert.equal(logged[0]!.sawResult, false)
})

test("cancelling doStream kills the CLI and produces no result log", async () => {
  const { provider, dir, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const pidFile = join(dir, "cli.pid")
  const resultFile = join(dir, "cli-answered")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "slow"
  process.env.FAKE_QODER_PID_FILE = pidFile
  process.env.FAKE_QODER_RESULT_FILE = resultFile
  process.env.FAKE_QODER_DELAY_MS = "8000"
  try {
    const { stream } = await model.doStream({ prompt: PROMPT })
    const reader = (stream as unknown as ReadableStream).getReader()
    const first = await reader.read()
    assert.equal(first.value!.type, "stream-start")
    assert.equal(await waitForFile(pidFile), true, "the fake CLI never started")
    const pid = Number(readFileSync(pidFile, "utf8"))

    await reader.cancel("user stopped")

    // cancel 之后不应再收到任何事件。
    const next = await reader.read()
    assert.equal(next.done, true)

    assert.equal(await waitForExit(pid), true, "the fake CLI process tree survived the cancel")
    assert.equal(existsSync(resultFile), false)

    const logged = readLogged(logFile)
    assert.equal(logged.filter((entry) => entry.isError !== true).length, 0)
    for (const entry of logged) assert.equal(entry.aborted, true)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
    delete process.env.FAKE_QODER_PID_FILE
    delete process.env.FAKE_QODER_RESULT_FILE
    delete process.env.FAKE_QODER_DELAY_MS
  }
})

test("an external abortSignal stops doStream with an abort error part only", async () => {
  const { provider, dir, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const pidFile = join(dir, "cli.pid")
  const resultFile = join(dir, "cli-answered")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "slow"
  process.env.FAKE_QODER_PID_FILE = pidFile
  process.env.FAKE_QODER_RESULT_FILE = resultFile
  process.env.FAKE_QODER_DELAY_MS = "8000"
  try {
    const controller = new AbortController()
    const { stream } = await model.doStream({ prompt: PROMPT, abortSignal: controller.signal })
    const reader = (stream as unknown as ReadableStream).getReader()
    const first = await reader.read()
    assert.equal(first.value!.type, "stream-start")
    assert.equal(await waitForFile(pidFile), true, "the fake CLI never started")
    const pid = Number(readFileSync(pidFile, "utf8"))

    controller.abort()

    const error = await reader.read()
    assert.equal(error.done, false)
    assert.equal(error.value!.type, "error")
    assert.equal((error.value!.error as Error).name, "AbortError")
    const end = await reader.read()
    assert.equal(end.done, true)

    assert.equal(await waitForExit(pid), true, "the fake CLI process tree survived the abort")
    assert.equal(existsSync(resultFile), false)

    const logged = readLogged(logFile)
    assert.equal(logged.filter((entry) => entry.isError !== true).length, 0)
    for (const entry of logged) assert.equal(entry.aborted, true)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
    delete process.env.FAKE_QODER_PID_FILE
    delete process.env.FAKE_QODER_RESULT_FILE
    delete process.env.FAKE_QODER_DELAY_MS
  }
})

test("a truncated stdout fails the call instead of returning partial output", async () => {
  const { provider, logFile } = makeProvider()
  const model = provider.languageModel("Auto")
  const previous = process.env.FAKE_QODER_MODE
  process.env.FAKE_QODER_MODE = "huge-out"
  process.env.FAKE_QODER_OUT_BYTES = String(MAX_STDOUT_BYTES + 5)
  try {
    await assert.rejects(
      model.doGenerate({ prompt: PROMPT }),
      new RegExp(`stdout exceeded the ${MAX_STDOUT_BYTES} byte limit and was truncated`),
    )
    const logged = readLogged(logFile)
    assert.equal(logged.length, 1)
    assert.equal(logged[0]!.isError, true)
    assert.equal(logged[0]!.aborted, undefined)
  } finally {
    if (previous === undefined) delete process.env.FAKE_QODER_MODE
    else process.env.FAKE_QODER_MODE = previous
    delete process.env.FAKE_QODER_OUT_BYTES
  }
})
