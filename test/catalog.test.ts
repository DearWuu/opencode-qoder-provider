import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { MAX_STDOUT_BYTES } from "../src/cli.mjs"
import { fetchCliVersion, fetchModelList } from "../src/catalog.mjs"

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-qoder.mjs", import.meta.url))

function tempDir() {
  return mkdtempSync(join(tmpdir(), "qoder-catalog-test-"))
}

async function withEnv(overrides: Record<string, string | undefined>, run: () => Promise<unknown>) {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(overrides)) previous[key] = process.env[key]
  Object.assign(process.env, overrides)
  try {
    return await run()
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test("fetchModelList returns an empty list when the CLI knows no models", async () => {
  const result = await withEnv({ FAKE_QODER_MODELS: "" }, () =>
    fetchModelList({ cliPath: FAKE_CLI, cwd: tempDir(), timeoutMs: 20_000 }),
  )
  assert.deepEqual(result, [])
})

test("fetchModelList fails when --list-models hangs past the discovery timeout", async () => {
  await assert.rejects(
    withEnv({ FAKE_QODER_DISCOVERY_DELAY_MS: "3000" }, () =>
      fetchModelList({ cliPath: FAKE_CLI, cwd: tempDir(), timeoutMs: 300 }),
    ),
    /--list-models timed out after 300 ms/,
  )
})

test("fetchModelList fails when --list-models output is truncated", async () => {
  await assert.rejects(
    withEnv({ FAKE_QODER_LIST_OUT_BYTES: String(MAX_STDOUT_BYTES + 5) }, () =>
      fetchModelList({ cliPath: FAKE_CLI, cwd: tempDir(), timeoutMs: 60_000 }),
    ),
    new RegExp(`stdout exceeded the ${MAX_STDOUT_BYTES} byte limit and was truncated`),
  )
})

test("fetchModelList reports the CLI exit code and stderr when auth fails", async () => {
  await assert.rejects(
    fetchModelList({ cliPath: join(tempDir(), "no-such-cli"), cwd: tempDir(), timeoutMs: 5_000 }),
    /Qoder CLI not found/,
  )
})

test("fetchCliVersion reads the version from the CLI", async () => {
  const version = await fetchCliVersion({ cliPath: FAKE_CLI, timeoutMs: 20_000 })
  assert.equal(version, "1.1.85")
})
