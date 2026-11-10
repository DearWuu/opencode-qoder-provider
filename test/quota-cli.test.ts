/**
 * 文件职责：假 PTY 验证 `/usage` 唯一斜杠输入、trust 处理、超时/abort 清理与跨平台启动参数。
 * 上游：node:test / Bun test。
 * 下游：src/quota-cli.mjs；不加载真实账户、不发送模型 prompt。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

import { isBunRuntime, ptyCommand, readOfficialUsage } from "../src/quota-cli.mjs"

const RECORDED = readFileSync(fileURLToPath(new URL("./fixtures/official-usage.txt", import.meta.url)), "utf8")
const FAKE_INTERACTIVE = fileURLToPath(new URL("./fixtures/fake-interactive-usage.mjs", import.meta.url))
const FAST_TIMING = { trustDelayMs: 10, initialDelayMs: 10, settleDelayMs: 5, watchdogIntervalMs: 2 }

function fakePty({ trust = false, answer = true } = {}) {
  const child: any = {
    writes: [] as string[],
    kills: 0,
    disposals: 0,
    dataHandler: undefined,
    exitHandler: undefined,
    onData(handler: (chunk: string) => void) {
      child.dataHandler = handler
      return { dispose: () => { child.disposals += 1 } }
    },
    onExit(handler: () => void) {
      child.exitHandler = handler
      return { dispose: () => { child.disposals += 1 } }
    },
    write(text: string) {
      child.writes.push(text)
      if (text === "/usage\r" && answer) queueMicrotask(() => child.dataHandler?.(RECORDED))
    },
    kill() {
      child.kills += 1
    },
  }
  const spawnPty = (...args: any[]) => {
    child.spawnArgs = args
    if (trust) setTimeout(() => child.dataHandler?.("Do you trust the files in this folder?"), 0)
    return child
  }
  return { child, spawnPty }
}

test("trust handling writes only Enter and the official /usage slash command", async () => {
  const { child, spawnPty } = fakePty({ trust: true })
  const output = await readOfficialUsage({
    cliPath: "/plugin/qoderclicn.js",
    spawnPty,
    timeoutMs: 500,
    timing: FAST_TIMING,
  } as never)
  assert.equal(output.includes(RECORDED), true)
  assert.match(output, /Do you trust the files in this folder\?/)
  assert.deepEqual(child.writes, ["\r", "/usage\r"])
  assert.equal(child.kills, 1)
  assert.equal(child.disposals, 2)
  const [file, args] = child.spawnArgs
  assert.equal(basename(file).toLowerCase(), process.platform === "win32" ? "node.exe" : "node")
  assert.deepEqual(args, ["/plugin/qoderclicn.js", "--permission-mode", "default"])
  assert.equal(args.includes("-p"), false)
})

test("a trusted CLI needs no trust input and still sends no model prompt", async () => {
  const { child, spawnPty } = fakePty()
  await readOfficialUsage({ cliPath: "qoderclicn", spawnPty, timeoutMs: 500, timing: FAST_TIMING } as never)
  assert.deepEqual(child.writes, ["/usage\r"])
  assert.equal(child.kills, 1)
  assert.equal(child.disposals, 2)
})

test("PTY timeout kills the process and disposes both listeners", async () => {
  const { child, spawnPty } = fakePty({ answer: false })
  await assert.rejects(
    readOfficialUsage({
      cliPath: "qoderclicn",
      spawnPty,
      timeoutMs: 20,
      timing: { ...FAST_TIMING, initialDelayMs: 1_000 },
    } as never),
    /\/usage timed out after 20 ms/,
  )
  assert.equal(child.kills, 1)
  assert.equal(child.disposals, 2)
  assert.deepEqual(child.writes, [])
})

test("abort kills the PTY and does not emit a late quota answer", async () => {
  const { child, spawnPty } = fakePty({ answer: false })
  const controller = new AbortController()
  const pending = readOfficialUsage({
    cliPath: "qoderclicn",
    spawnPty,
    timeoutMs: 500,
    signal: controller.signal,
    timing: FAST_TIMING,
  } as never)
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError")
  assert.equal(child.kills, 1)
  assert.equal(child.disposals, 2)
})

test("Bun runtime reads /usage through the Node bridge without extra CLI input", async (t) => {
  if (!isBunRuntime()) {
    t.skip("Bun-only node-pty bridge")
    return
  }
  const dir = mkdtempSync(join(tmpdir(), "qoder-quota-bridge-"))
  const inputLog = join(dir, "inputs.jsonl")
  const output = await readOfficialUsage({
    cliPath: FAKE_INTERACTIVE,
    cwd: dir,
    timeoutMs: 5_000,
    env: {
      ...process.env,
      FAKE_USAGE_INPUT_LOG: inputLog,
      FAKE_USAGE_FIXTURE: fileURLToPath(new URL("./fixtures/official-usage.txt", import.meta.url)),
    },
    timing: FAST_TIMING,
  } as never)
  assert.equal(output.replace(/\r/g, "").includes(RECORDED), true)
  const inputs = readFileSync(inputLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const extra = inputs.filter((value) => !["\r", "\n", "/usage\r", "/usage\n"].includes(value))
  assert.deepEqual(extra, [])
  assert.equal(inputs.some((value) => String(value).trim() === "/usage"), true)
})

test("Windows JS bundles use Node and cmd shims use ComSpec", () => {
  const js = ptyCommand("C:\\plugin\\qoderclicn.js", "win32", {}, "C:\\node\\node.exe")
  assert.equal(js.file, "C:\\node\\node.exe")
  assert.deepEqual(js.args, ["C:\\plugin\\qoderclicn.js", "--permission-mode", "default"])
  const mjs = ptyCommand("/plugin/qoder.mjs", "linux", {}, "/usr/bin/node")
  assert.equal(mjs.file, "/usr/bin/node")
  assert.deepEqual(mjs.args, ["/plugin/qoder.mjs", "--permission-mode", "default"])
  const cmd = ptyCommand("C:\\plugin\\qoderclicn.cmd", "win32", { ComSpec: "C:\\Windows\\cmd.exe" })
  assert.equal(cmd.file, "C:\\Windows\\cmd.exe")
  assert.match(cmd.args.at(-1)!, /qoderclicn\.cmd/)
  assert.match(cmd.args.at(-1)!, /--permission-mode default/)
})
