/**
 * 文件职责：provider 系列测试共享的脚手架：假 CLI、临时目录、日志读取、环境变量注入。
 * 上游：test/provider-*.test.ts。
 * 下游：src/provider.createQoder、test/fixtures/fake-qoder.mjs。
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createQoder } from "../src/provider.mjs"

export const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "qoder-provider-test-"))
}

export function makeProvider(overrides: Record<string, unknown> = {}) {
  const dir = tempDir()
  const logFile = join(dir, "calls.jsonl")
  const provider = createQoder({
    cliPath: FAKE_CLI,
    cwd: dir,
    timeoutMs: 20_000,
    logFile,
    ...overrides,
  })
  return { provider, dir, logFile }
}

export const PROMPT = [
  { role: "system", content: "be brief" },
  { role: "user", content: [{ type: "text", text: "hello" }] },
]

export async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return false
}

export async function waitForFile(file: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  return false
}

export function readLogged(logFile: string): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export interface FakeEnvKeys {
  FAKE_QODER_MODE?: string
  FAKE_QODER_PID_FILE?: string
  FAKE_QODER_CHILD_PID_FILE?: string
  FAKE_QODER_RECORD?: string
  FAKE_QODER_PARTIAL_DELAY_MS?: string
  FAKE_QODER_ZERO_USAGE?: string
  FAKE_QODER_CONTEXT_RATIO?: string
  FAKE_QODER_RESULT_TEXT?: string
  FAKE_QODER_STOP_REASON?: string
  FAKE_QODER_USAGE_SPLIT?: string
  FAKE_QODER_EMPTY_STOP?: string
}

export async function withFakeEnv(overrides: FakeEnvKeys, run: () => Promise<void>) {
  const previous: FakeEnvKeys = {}
  for (const key of Object.keys(overrides) as Array<keyof FakeEnvKeys>) {
    previous[key] = process.env[key]
    const value = overrides[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const key of Object.keys(previous) as Array<keyof FakeEnvKeys>) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}
