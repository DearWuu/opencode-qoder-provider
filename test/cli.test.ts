import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  MAX_STDERR_BYTES,
  MAX_STDOUT_BYTES,
  buildCliArgs,
  killTree,
  parseCliResult,
  resolveSpawnCommand,
  runCli,
} from "../src/cli.mjs"

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

test("buildCliArgs puts --append-system-prompt before --strict-mcp-config and keeps --tools last", () => {
  const args = buildCliArgs({
    modelID: "Auto",
    additionalDirs: ["/extra"],
    cliTools: ["Read"],
    bridge: true,
    appendSystemPrompt: "protocol",
  })
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "protocol")
  const promptIndex = args.indexOf("--append-system-prompt")
  const mcpIndex = args.indexOf("--strict-mcp-config")
  const dirIndex = args.indexOf("--add-dir")
  const toolsIndex = args.indexOf("--tools")
  assert.ok(promptIndex < mcpIndex, "--append-system-prompt must come before --strict-mcp-config")
  assert.ok(mcpIndex < dirIndex, "--strict-mcp-config must come before --add-dir")
  assert.ok(dirIndex < toolsIndex, "--add-dir must come before the variadic --tools")
  // 桥接模式覆盖 cliTools：内置工具一律关闭。
  assert.deepEqual(args.slice(toolsIndex), ["--tools", ""])
})

test("buildCliArgs forwards a standalone --append-system-prompt without bridge mode", () => {
  const args = buildCliArgs({ modelID: "Auto", appendSystemPrompt: "sys" })
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "sys")
  assert.equal(args.includes("--strict-mcp-config"), false)
  assert.equal(args.includes("--tools"), false)

  assert.equal(buildCliArgs({ modelID: "Auto", appendSystemPrompt: "" }).includes("--append-system-prompt"), false)
  assert.equal(buildCliArgs({ modelID: "Auto", bridge: true }).includes("--append-system-prompt"), false)
})

test("buildCliArgs never adds --strict-mcp-config outside bridge mode", () => {
  assert.equal(buildCliArgs({ modelID: "Auto", cliTools: "" }).includes("--strict-mcp-config"), false)
  assert.equal(buildCliArgs({ modelID: "Auto", cliTools: ["Read"] }).includes("--strict-mcp-config"), false)
  assert.equal(buildCliArgs({ modelID: "Auto", stream: true }).includes("--strict-mcp-config"), false)
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

test("runCli rewrites --append-system-prompt into --append-system-prompt-file and removes the temp dir", async () => {
  const dir = tempDir()
  const record = join(dir, "record.json")
  const systemPrompt = "tool bridge protocol line\n".repeat(2000)
  const args = buildCliArgs({ modelID: "Auto", bridge: true, appendSystemPrompt: systemPrompt })
  const originalIndex = args.indexOf("--append-system-prompt")

  const run = await runCli({
    cliPath: FAKE_CLI,
    args,
    input: "hi",
    cwd: dir,
    timeoutMs: 20_000,
    env: { ...process.env, FAKE_QODER_RECORD: record },
  })

  assert.equal(run.code, 0)
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  // 内联文本不再出现在命令行里，只留文件路径。
  assert.equal(recorded.argv.includes("--append-system-prompt"), false)
  const fileIndex = recorded.argv.indexOf("--append-system-prompt-file")
  assert.equal(fileIndex, originalIndex, "--append-system-prompt-file must keep the original flag position")
  assert.match(recorded.systemPrompt.path, /append-system-prompt\.md$/)
  assert.equal(recorded.systemPrompt.content, systemPrompt)
  // 运行结束后临时目录整体删除。
  assert.equal(existsSync(dirname(recorded.systemPrompt.path)), false)
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

test("killTree on Windows runs taskkill /pid <pid> /t /f without a visible window", () => {
  const calls: Array<[string, string[], { stdio: string, windowsHide: boolean }]> = []
  const taskkill = new EventEmitter()
  const signals: string[] = []
  const child = { pid: 4242, kill: (signal: string) => signals.push(signal) }

  killTree(child as never, {
    platform: "win32",
    spawnProcess: ((command: string, args: string[], options: { stdio: string, windowsHide: boolean }) => {
      calls.push([command, args, options])
      return taskkill
    }) as never,
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ["taskkill", ["/pid", "4242", "/t", "/f"], { stdio: "ignore", windowsHide: true }])

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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64")

/** 等 fake CLI 把 record 写出来（stdin 结束即写），避免在强负载下 CLI 还没启动就被超时终止。 */
async function waitForRecord(file: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`fake CLI did not write ${file} within ${timeoutMs}ms`)
}

test("runCli writes attachments to temp files, passes --attachment per file and removes them afterwards", async () => {
  const dir = tempDir()
  const record = join(dir, "record.json")

  const run = await runCli({
    cliPath: FAKE_CLI,
    args: buildCliArgs({ modelID: "Auto", cliTools: "" }),
    attachments: [
      { mediaType: "image/png", data: PNG_BYTES },
      { mediaType: "image/jpeg", data: JPEG_BASE64 },
      { mediaType: "image/heic", data: "AAAA" },
    ],
    input: "describe the images",
    cwd: dir,
    timeoutMs: 20_000,
    env: { ...process.env, FAKE_QODER_RECORD: record },
  })

  assert.equal(run.code, 0)
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  assert.equal(recorded.stdin, "describe the images")
  assert.equal(recorded.argv.filter((arg: string) => arg === "--attachment").length, 3)
  assert.deepEqual(
    recorded.attachments.map((attachment: { base64: string }) => attachment.base64),
    [Buffer.from(PNG_BYTES).toString("base64"), JPEG_BASE64, "AAAA"],
  )
  // 扩展名按 mediaType 映射，未知图片类型退化为 .bin。
  assert.match(recorded.attachments[0].path, /attachment-0\.png$/)
  assert.match(recorded.attachments[1].path, /attachment-1\.jpg$/)
  assert.match(recorded.attachments[2].path, /attachment-2\.bin$/)
  // `--tools` 是变长参数，附件必须插在它前面，否则路径会被当成工具名。
  assert.equal(recorded.argv.indexOf("--tools"), recorded.argv.length - 2)

  // 运行结束后临时目录整体删除。
  const attachmentDir = dirname(recorded.attachments[0].path)
  assert.equal(existsSync(attachmentDir), false)
  for (const attachment of recorded.attachments) {
    assert.equal(existsSync(attachment.path), false)
  }
})

test("runCli removes attachment temp files when the CLI fails", async () => {
  const dir = tempDir()
  const record = join(dir, "record.json")

  const run = await runCli({
    cliPath: FAKE_CLI,
    args: buildCliArgs({ modelID: "Auto" }),
    attachments: [{ mediaType: "image/png", data: PNG_BYTES }],
    input: "describe the image",
    cwd: dir,
    timeoutMs: 20_000,
    env: { ...process.env, FAKE_QODER_RECORD: record, FAKE_QODER_MODE: "crash" },
  })

  assert.equal(run.code, 1)
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  assert.equal(recorded.attachments.length, 1)
  assert.equal(existsSync(dirname(recorded.attachments[0].path)), false)
})

test("runCli removes attachment temp files when the call times out", async () => {
  const dir = tempDir()
  const record = join(dir, "record.json")

  const pending = runCli({
    cliPath: FAKE_CLI,
    args: buildCliArgs({ modelID: "Auto" }),
    attachments: [{ mediaType: "image/png", data: PNG_BYTES }],
    input: "describe the image",
    cwd: dir,
    timeoutMs: 2_000,
    env: { ...process.env, FAKE_QODER_RECORD: record, FAKE_QODER_MODE: "hang" },
  })
  await waitForRecord(record)
  const run = await pending

  assert.equal(run.timedOut, true)
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  assert.equal(recorded.attachments.length, 1)
  assert.equal(existsSync(dirname(recorded.attachments[0].path)), false)
})

test("runCli removes attachment temp files when the call is aborted", async () => {
  const dir = tempDir()
  const record = join(dir, "record.json")
  const controller = new AbortController()

  const pending = runCli({
    cliPath: FAKE_CLI,
    args: buildCliArgs({ modelID: "Auto" }),
    attachments: [{ mediaType: "image/png", data: PNG_BYTES }],
    input: "describe the image",
    cwd: dir,
    timeoutMs: 20_000,
    signal: controller.signal,
    env: { ...process.env, FAKE_QODER_RECORD: record, FAKE_QODER_MODE: "hang" },
  })
  setTimeout(() => controller.abort(), 800)
  await waitForRecord(record)
  const run = await pending

  assert.equal(run.aborted, true)
  const recorded = JSON.parse(readFileSync(record, "utf8"))
  assert.equal(recorded.attachments.length, 1)
  assert.equal(existsSync(dirname(recorded.attachments[0].path)), false)
})

test("runCli rejects attachment data that is neither Uint8Array nor base64", async () => {
  await assert.rejects(
    runCli({
      cliPath: FAKE_CLI,
      args: ["-p", "-o", "json"],
      attachments: [{ mediaType: "image/png", data: 42 as never }],
      timeoutMs: 5_000,
    }),
    /Uint8Array or a base64 string/,
  )
})

test("buildCliArgs puts --reasoning-effort after --append-system-prompt and before --strict-mcp-config", () => {
  const args = buildCliArgs({
    modelID: "Auto",
    bridge: true,
    appendSystemPrompt: "sys",
    reasoningEffort: "xhigh",
    additionalDirs: ["/extra"],
  })
  const promptIndex = args.indexOf("--append-system-prompt")
  const effortIndex = args.indexOf("--reasoning-effort")
  const mcpIndex = args.indexOf("--strict-mcp-config")
  const dirIndex = args.indexOf("--add-dir")
  assert.equal(args[effortIndex + 1], "xhigh")
  assert.ok(promptIndex < effortIndex, "--reasoning-effort must come after --append-system-prompt")
  assert.ok(effortIndex < mcpIndex, "--reasoning-effort must come before --strict-mcp-config")
  assert.ok(mcpIndex < dirIndex, "--strict-mcp-config must come before --add-dir")
  assert.deepEqual(args.slice(args.indexOf("--tools")), ["--tools", ""])
})

test("buildCliArgs skips --reasoning-effort for auto, undefined and unknown values", () => {
  for (const value of [undefined, "auto", "bogus", "", 5, null]) {
    assert.equal(buildCliArgs({ modelID: "Auto", reasoningEffort: value as never }).includes("--reasoning-effort"), false)
  }
  const full = buildCliArgs({ modelID: "Auto", reasoningEffort: "max" })
  assert.deepEqual(full.slice(-2), ["--reasoning-effort", "max"])
  const plain = buildCliArgs({ modelID: "Auto", appendSystemPrompt: "sys", reasoningEffort: "low" })
  assert.deepEqual(plain.slice(plain.indexOf("--append-system-prompt")), [
    "--append-system-prompt",
    "sys",
    "--reasoning-effort",
    "low",
  ])
})

test("resolveSpawnCommand on Windows wraps a .js CLI with node and keeps the argument order", () => {
  const cliPath = "x/y/qoderclicn.js"
  const args = ["-p", "hi"]
  assert.deepEqual(resolveSpawnCommand(cliPath, args, "win32"), {
    command: "node",
    args: ["x/y/qoderclicn.js", "-p", "hi"],
  })
  // 大小写不敏感：Windows 上 .JS / .MJS / .CJS 同样需要 node 包装。
  assert.deepEqual(resolveSpawnCommand("C:\\root\\QODERCLICN.JS", ["--list-models"], "win32"), {
    command: "node",
    args: ["C:\\root\\QODERCLICN.JS", "--list-models"],
  })
})

test("resolveSpawnCommand on Windows wraps a .cmd CLI with cmd.exe /d /s /c", () => {
  const cliPath = "C:\\root\\qodercli.CMD"
  const args = ["--list-models"]
  const resolved = resolveSpawnCommand(cliPath, args, "win32")
  assert.equal(resolved.command, process.env.ComSpec ?? "cmd.exe")
  assert.deepEqual(resolved.args, ["/d", "/s", "/c", "C:\\root\\qodercli.CMD", "--list-models"])
  assert.deepEqual(resolveSpawnCommand("C:\\root\\qodercli.bat", [], "win32").args.slice(0, 4), [
    "/d",
    "/s",
    "/c",
    "C:\\root\\qodercli.bat",
  ])
})

test("resolveSpawnCommand leaves .js CLIs untouched on non-Windows platforms", () => {
  const cliPath = "/usr/lib/qoder/qoderclicn.js"
  const args = ["-p", "hi"]
  assert.deepEqual(resolveSpawnCommand(cliPath, args, "linux"), { command: cliPath, args })
  assert.deepEqual(resolveSpawnCommand(cliPath, args, "darwin"), { command: cliPath, args })
  // 非 win32 不因 .cmd/.bat 扩展名包装。
  assert.deepEqual(resolveSpawnCommand("/tmp/qodercli.cmd", ["--version"], "linux"), {
    command: "/tmp/qodercli.cmd",
    args: ["--version"],
  })
})

test("resolveSpawnCommand leaves Windows executables and extensionless CLIs untouched", () => {
  const exePath = "C:\\tools\\qodercli.EXE"
  assert.deepEqual(resolveSpawnCommand(exePath, ["--list-models"], "win32"), {
    command: exePath,
    args: ["--list-models"],
  })
  const bare = "C:\\tools\\qodercli"
  assert.deepEqual(resolveSpawnCommand(bare, ["--version"], "win32"), { command: bare, args: ["--version"] })
})
