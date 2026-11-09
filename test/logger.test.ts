import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { appendCallLog, buildLogEntry, readCallLog, sumCredits } from "../src/logger.mjs"
import { defaultLogFile } from "../src/options.mjs"

function tempFile() {
  return join(mkdtempSync(join(tmpdir(), "qoder-log-test-")), "nested", "calls.jsonl")
}

test("buildLogEntry keeps only metadata, never the prompt", () => {
  const entry = buildLogEntry({
    requestedModel: "Auto",
    actualModel: "Auto",
    modelFallback: false,
    usageModelKey: "auto",
    usageModelKeys: ["auto"],
    credits: 0.25,
    durationMs: 42,
    isError: false,
    exitCode: 0,
    sessionId: "session-1",
  })

  assert.equal(entry.provider, "qoder")
  assert.equal(entry.model, "Auto")
  assert.equal(entry.credits, 0.25)
  assert.equal(entry.actualModel, "Auto")
  assert.equal(entry.usageModelKey, "auto")
  assert.deepEqual(entry.usageModelKeys, ["auto"])
  assert.equal(entry.sessionId, "session-1")
  assert.equal("prompt" in entry, false)
  assert.equal("auth" in entry, false)
  assert.equal("token" in entry, false)
})

test("appendCallLog writes JSON lines and creates the directory", () => {
  const file = tempFile()
  appendCallLog(file, buildLogEntry({ requestedModel: "Auto", credits: 0.5, durationMs: 10 }))
  appendCallLog(file, buildLogEntry({ requestedModel: "Fast", credits: 0.25, durationMs: 20 }))

  const lines = readFileSync(file, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]!).model, "Auto")
  assert.equal(JSON.parse(lines[1]!).model, "Fast")
})

test("readCallLog ignores corrupted lines and sumCredits adds them up", () => {
  const file = tempFile()
  appendCallLog(file, buildLogEntry({ requestedModel: "Auto", credits: 0.5 }))
  appendFileSync(file, "not json\n", "utf8")
  appendCallLog(file, buildLogEntry({ requestedModel: "Fast", credits: 0.25 }))

  const entries = readCallLog(file, 10)
  assert.equal(entries.length, 2)
  assert.equal(sumCredits(entries), 0.75)
})

test("defaultLogFile honours XDG_STATE_HOME", () => {
  assert.equal(
    defaultLogFile({ XDG_STATE_HOME: "/tmp/state" } as NodeJS.ProcessEnv),
    "/tmp/state/opencode/qoder-provider/calls.jsonl",
  )
  assert.match(defaultLogFile({} as NodeJS.ProcessEnv), /\.local\/state\/opencode\/qoder-provider\/calls\.jsonl$/)
})

test("readCallLog returns an empty list for a missing file", () => {
  assert.deepEqual(readCallLog(join(tmpdir(), "qoder-does-not-exist.jsonl")), [])
})

test("appendCallLog keeps the log private: directory 0700, file 0600", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits do not exist on Windows")
    return
  }
  const file = tempFile()
  appendCallLog(file, buildLogEntry({ requestedModel: "Auto", credits: 0.5 }))

  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700)
  assert.equal(statSync(file).mode & 0o777, 0o600)

  // A world-readable file created by an older version is tightened best effort.
  chmodSync(file, 0o644)
  appendCallLog(file, buildLogEntry({ requestedModel: "Fast", credits: 0.25 }))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2)
})
