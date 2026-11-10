import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { MAX_STDERR_BYTES, MAX_STDOUT_BYTES, buildCliArgs, killTree, parseCliResult, runCli } from "../src/cli.mjs"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))

function tempDir() {
  return mkdtempSync(join(tmpdir(), "qoder-cli-test-"))
}

test("buildCliArgs never passes --input-format", () => {
  const args = buildCliArgs({ modelID: "Auto", cwd: "/tmp/work", permissionMode: "accept_edits" })
  assert.deepEqual(args, [
    "-p",
    "-o",
    "json",
    "--permission-mode",
    "accept_edits",
    "--no-session-persistence",
    "--cwd",
    "/tmp/work",
    "--model",
    "Auto",
  ])
  assert.equal(args.includes("--input-format"), false)
  assert.equal(args.some((arg) => arg.startsWith("--input-format")), false)
})

test("buildCliArgs appends --add-dir once per directory", () => {
  const args = buildCliArgs({ modelID: "Auto", additionalDirs: ["/data/inbox", "/data/outbox"] })
  assert.deepEqual(args, [
    "-p",
    "-o",
    "json",
    "--no-session-persistence",
    "--model",
    "Auto",
    "--add-dir",
    "/data/inbox",
    "--add-dir",
    "/data/outbox",
  ])
})

test("buildCliArgs keeps the variadic --tools flag last", () => {
  const list = buildCliArgs({ modelID: "Auto", additionalDirs: ["/extra"], cliTools: ["Read", "Grep"] })
  assert.deepEqual(list.slice(list.indexOf("--tools")), ["--tools", "Read", "Grep"])
  assert.equal(list.includes("--add-dir"), true)

  const disabled = buildCliArgs({ cliTools: "" })
  assert.deepEqual(disabled.slice(disabled.indexOf("--tools")), ["--tools", ""])

  // 空数组与 "" 一样，禁用全部内置工具。
  assert.deepEqual(buildCliArgs({ cliTools: [] }).slice(-2), ["--tools", ""])
  assert.equal(buildCliArgs({ cliTools: undefined }).includes("--tools"), false)
  assert.equal(buildCliArgs({ additionalDirs: [] }).includes("--add-dir"), false)
})

test("buildCliArgs forwards maxOutputTokens only for positive integers", () => {
  assert.deepEqual(buildCliArgs({ modelID: "Auto", maxOutputTokens: 4096 }).slice(-2), [
    "--max-output-tokens",
    "4096",
  ])
  assert.deepEqual(buildCliArgs({ modelID: "Auto", maxOutputTokens: 1 }).slice(-2), ["--max-output-tokens", "1"])

  // 非法值被忽略：不传 flag，也不会让 CLI 调用失败。
  for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "4096", null]) {
    assert.equal(buildCliArgs({ modelID: "Auto", maxOutputTokens: invalid as never }).includes("--max-output-tokens"), false)
  }
  assert.equal(buildCliArgs({ modelID: "Auto" }).includes("--max-output-tokens"), false)
})

test("the CLI receives the prompt as plain text on stdin", async () => {
  const dir = tempDir()
  const record = join(dir, "record.json")
  const prompt = "[system]\nbe nice\n\n[user]\nhello world"

  const run = await runCli({
    cliPath: FAKE_CLI,
    args: buildCliArgs({ modelID: "Auto", cwd: dir, permissionMode: "accept_edits" }),
    input: prompt,
    cwd: dir,
    timeoutMs: 20_000,
    env: { ...process.env, FAKE_QODER_RECORD: record },
  })

  assert.equal(run.code, 0)
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  assert.equal(recorded.stdin, prompt)
  assert.equal(recorded.stdinBytes, Buffer.byteLength(prompt, "utf8"))
  assert.equal(recorded.argv.includes("--input-format"), false)
  assert.equal(recorded.argv.includes("--no-session-persistence"), true)
  assert.deepEqual(recorded.argv.slice(0, 3), ["-p", "-o", "json"])
})

test("parseCliResult reads the JSON document out of the CLI output", () => {
  const parsed = parseCliResult('warning line\n{"type":"result","result":"hello"}\n')
  assert.equal(parsed.type, "result")
  assert.equal(parsed.result, "hello")
})

test("parseCliResult fails when the CLI returns no JSON", () => {
  assert.throws(() => parseCliResult("not json"), /did not return a JSON result|returned no output/)
})

test("runCli reports a missing CLI binary", async () => {
  await assert.rejects(
    runCli({ cliPath: join(tempDir(), "does-not-exist"), args: ["--version"], timeoutMs: 5_000 }),
    /Qoder CLI not found/,
  )
})

test("stdout is truncated at exactly the 32 MiB cap and the truncation is flagged", async () => {
  const dir = tempDir()
  const run = await runCli({
    cliPath: FAKE_CLI,
    args: ["-p", "-o", "json"],
    cwd: dir,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      FAKE_QODER_MODE: "huge-out",
      FAKE_QODER_OUT_BYTES: String(MAX_STDOUT_BYTES + 5),
    },
  })

  assert.equal(run.stdoutTruncated, true)
  assert.equal(Buffer.byteLength(run.stdout, "utf8"), MAX_STDOUT_BYTES)
  assert.equal(run.code, 0)
  assert.equal(run.timedOut, false)
})

test("stdout at exactly the cap is kept whole without a truncation flag", async () => {
  const dir = tempDir()
  const run = await runCli({
    cliPath: FAKE_CLI,
    args: ["-p", "-o", "json"],
    cwd: dir,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      FAKE_QODER_MODE: "huge-out",
      FAKE_QODER_OUT_BYTES: String(MAX_STDOUT_BYTES),
    },
  })

  assert.equal(run.stdoutTruncated, false)
  assert.equal(Buffer.byteLength(run.stdout, "utf8"), MAX_STDOUT_BYTES)
})

test("stderr is truncated at exactly the 8 KiB cap and the truncation is flagged", async () => {
  const dir = tempDir()
  const run = await runCli({
    cliPath: FAKE_CLI,
    args: ["-p", "-o", "json"],
    input: "hello",
    cwd: dir,
    timeoutMs: 30_000,
    env: {
      ...process.env,
      FAKE_QODER_MODE: "huge-err",
      FAKE_QODER_ERR_BYTES: String(MAX_STDERR_BYTES + 7),
    },
  })

  assert.equal(run.stderrTruncated, true)
  assert.equal(Buffer.byteLength(run.stderr, "utf8"), MAX_STDERR_BYTES)
  assert.equal(run.stdout.includes('"type":"result"'), true)
  assert.equal(run.code, 0)
})

test("killTree on Windows runs taskkill /pid <pid> /t /f", () => {
  const calls: Array<[string, string[]]> = []
  const taskkill = new EventEmitter()
  const signals: string[] = []
  const child = { pid: 4242, kill: (signal: string) => signals.push(signal) }

  killTree(child as never, {
    platform: "win32",
    spawnProcess: ((command: string, args: string[]) => {
      calls.push([command, args])
      return taskkill
    }) as never,
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ["taskkill", ["/pid", "4242", "/t", "/f"]])

  taskkill.emit("error", new Error("taskkill is not available"))
  assert.deepEqual(signals, ["SIGKILL"])
})

test("killTree falls back to child.kill when spawning taskkill throws", () => {
  const signals: string[] = []
  const child = { pid: 4242, kill: (signal: string) => signals.push(signal) }

  killTree(child as never, {
    platform: "win32",
    spawnProcess: (() => {
      throw new Error("spawn EPERM")
    }) as never,
  })

  assert.deepEqual(signals, ["SIGKILL"])
})

test("buildCliArgs in stream mode switches to stream-json with partial messages", () => {
  const args = buildCliArgs({ modelID: "Auto", cwd: "/tmp/work", permissionMode: "default", stream: true })
  assert.deepEqual(args.slice(0, 6), ["-p", "-o", "stream-json", "--include-partial-messages", "--permission-mode", "default"])
  assert.equal(args.includes("json"), false)
})

test("buildCliArgs without stream mode keeps the single-document json output", () => {
  const args = buildCliArgs({ modelID: "Auto" })
  assert.deepEqual(args.slice(0, 3), ["-p", "-o", "json"])
  assert.equal(args.includes("--include-partial-messages"), false)
})

test("runCli forwards every stdout chunk to onStdout as they arrive", async () => {
  const dir = tempDir()
  const chunks: Buffer[] = []
  const run = await runCli({
    cliPath: FAKE_CLI,
    args: ["--list-models"],
    cwd: dir,
    timeoutMs: 20_000,
    env: { ...process.env, FAKE_QODER_MODELS: "Auto\nFast" },
    onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
  })
  assert.equal(run.code, 0)
  assert.ok(chunks.length >= 1)
  assert.equal(Buffer.concat(chunks).toString("utf8"), run.stdout)
})

test("runCli with collectStdout:false skips the raw capture but keeps onStdout", async () => {
  const dir = tempDir()
  const chunks: Buffer[] = []
  const run = await runCli({
    cliPath: FAKE_CLI,
    args: ["--list-models"],
    cwd: dir,
    timeoutMs: 20_000,
    env: { ...process.env, FAKE_QODER_MODELS: "Auto\nFast" },
    collectStdout: false,
    onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
  })
  assert.equal(run.code, 0)
  assert.ok(chunks.length >= 1)
  // 流消费者拿到了全部字节；原始副本从未被解码。
  assert.match(Buffer.concat(chunks).toString("utf8"), /MODEL\nAuto\nFast/)
  assert.equal(run.stdout, "")
  assert.equal(run.stdoutTruncated, false)
})

test("runCli with collectStdout:false still detects stdout truncation", async () => {
  const dir = tempDir()
  const run = await runCli({
    cliPath: FAKE_CLI,
    args: ["-p", "-o", "json"],
    cwd: dir,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      FAKE_QODER_MODE: "huge-out",
      FAKE_QODER_OUT_BYTES: String(MAX_STDOUT_BYTES + 5),
    },
    collectStdout: false,
  })
  assert.equal(run.stdoutTruncated, true)
  assert.equal(run.stdout, "")
})
