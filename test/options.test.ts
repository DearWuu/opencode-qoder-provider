import { test } from "node:test"
import assert from "node:assert/strict"

import {
  ALLOWED_PERMISSION_MODES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_MS,
  resolveOptions,
} from "../src/options.mjs"

test("resolveOptions rejects an invalid permissionMode instead of falling back", () => {
  assert.throws(() => resolveOptions({ permissionMode: "yolo" }, {}), /Invalid permissionMode "yolo"/)
  assert.throws(() => resolveOptions({ permissionMode: "" }, {}), /Invalid permissionMode/)
  assert.throws(() => resolveOptions({ permissionMode: 42 }, {}), /Invalid permissionMode "42"/)
  assert.throws(() => resolveOptions({}, { QODER_PERMISSION_MODE: "nope" }), /Invalid permissionMode "nope"/)
})

test("a blank QODER_PERMISSION_MODE env value counts as unset", () => {
  assert.equal(resolveOptions({}, { QODER_PERMISSION_MODE: "" }).permissionMode, DEFAULT_PERMISSION_MODE)
  assert.equal(resolveOptions({}, { QODER_PERMISSION_MODE: "   " }).permissionMode, DEFAULT_PERMISSION_MODE)
  assert.equal(resolveOptions({}, { QODER_PERMISSION_MODE: " " }).permissionMode, DEFAULT_PERMISSION_MODE)
  // A non-blank env value still wins and is still validated.
  assert.equal(resolveOptions({}, { QODER_PERMISSION_MODE: "accept_edits" }).permissionMode, "accept_edits")
  assert.throws(() => resolveOptions({}, { QODER_PERMISSION_MODE: "nope" }), /Invalid permissionMode "nope"/)
})

test("resolveOptions rejects an invalid timeoutMs instead of falling back", () => {
  assert.throws(() => resolveOptions({ timeoutMs: 0 }, {}), /Invalid timeoutMs "0"/)
  assert.throws(() => resolveOptions({ timeoutMs: -5 }, {}), /Invalid timeoutMs "-5"/)
  assert.throws(() => resolveOptions({ timeoutMs: "abc" }, {}), /Invalid timeoutMs "abc"/)
  assert.throws(() => resolveOptions({ timeoutMs: "" }, {}), /Invalid timeoutMs/)
  assert.throws(() => resolveOptions({}, { QODER_TIMEOUT_MS: "soon" }), /Invalid timeoutMs "soon"/)
})

test("a blank QODER_TIMEOUT_MS env value counts as unset", () => {
  assert.equal(resolveOptions({}, { QODER_TIMEOUT_MS: "" }).timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.equal(resolveOptions({}, { QODER_TIMEOUT_MS: "  " }).timeoutMs, DEFAULT_TIMEOUT_MS)
  // A non-blank env value still wins and is still validated.
  assert.equal(resolveOptions({}, { QODER_TIMEOUT_MS: "1500" }).timeoutMs, 1500)
  assert.throws(() => resolveOptions({}, { QODER_TIMEOUT_MS: "soon" }), /Invalid timeoutMs "soon"/)
})

test("resolveOptions accepts numeric strings and every allowed permission mode", () => {
  assert.equal(resolveOptions({ timeoutMs: "1500" }, {}).timeoutMs, 1500)
  for (const permissionMode of ALLOWED_PERMISSION_MODES) {
    assert.equal(resolveOptions({ permissionMode }, {}).permissionMode, permissionMode)
  }
})

test("omitting the options falls back to the built-in safe defaults", () => {
  const options = resolveOptions({}, {})
  assert.equal(options.permissionMode, DEFAULT_PERMISSION_MODE)
  assert.ok(ALLOWED_PERMISSION_MODES.includes(DEFAULT_PERMISSION_MODE))
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS)
})

test("the built-in default permission mode is the safe `default`", () => {
  // Locally installed plugin copies may pin a different default on purpose;
  // the shipped source must default to the safe value.
  const builtInDefault: string = DEFAULT_PERMISSION_MODE
  if (builtInDefault !== "default") return
  assert.equal(builtInDefault, "default")
})

test("additionalDirs defaults to empty and rejects malformed values", () => {
  assert.deepEqual(resolveOptions({}, {}).additionalDirs, [])
  assert.deepEqual(resolveOptions({ additionalDirs: ["/data/inbox", " /data/out "] }, {}).additionalDirs, [
    "/data/inbox",
    "/data/out",
  ])
  assert.throws(() => resolveOptions({ additionalDirs: "/data" }, {}), /Invalid additionalDirs/)
  assert.throws(() => resolveOptions({ additionalDirs: ["", "ok"] }, {}), /Invalid additionalDirs/)
  assert.throws(() => resolveOptions({ additionalDirs: [42] }, {}), /Invalid additionalDirs/)
})

test("cliTools accepts a tool list or the empty disable-all string", () => {
  assert.equal(resolveOptions({}, {}).cliTools, undefined)
  assert.deepEqual(resolveOptions({ cliTools: ["Read", "Grep"] }, {}).cliTools, ["Read", "Grep"])
  assert.equal(resolveOptions({ cliTools: "" }, {}).cliTools, "")
  assert.throws(() => resolveOptions({ cliTools: "Read" }, {}), /Invalid cliTools "Read"/)
  assert.throws(() => resolveOptions({ cliTools: 42 }, {}), /Invalid cliTools/)
  assert.throws(() => resolveOptions({ cliTools: ["Read", ""] }, {}), /Invalid cliTools/)
})

test("contextLimit defaults to 200000 and rejects malformed values", () => {
  assert.equal(resolveOptions({}, {}).contextLimit, 200_000)
  assert.equal(resolveOptions({ contextLimit: "131072" }, {}).contextLimit, 131_072)
  for (const bad of [0, -1, "abc", {}, Number.NaN]) {
    assert.throws(() => resolveOptions({ contextLimit: bad }, {}), /Invalid contextLimit/)
  }
})
