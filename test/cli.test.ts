import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildCliArgs, parseCliResult, runCli } from "../src/cli.mjs"

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
