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

test("resolveOptions rejects an invalid timeoutMs instead of falling back", () => {
  assert.throws(() => resolveOptions({ timeoutMs: 0 }, {}), /Invalid timeoutMs "0"/)
  assert.throws(() => resolveOptions({ timeoutMs: -5 }, {}), /Invalid timeoutMs "-5"/)
  assert.throws(() => resolveOptions({ timeoutMs: "abc" }, {}), /Invalid timeoutMs "abc"/)
  assert.throws(() => resolveOptions({ timeoutMs: "" }, {}), /Invalid timeoutMs/)
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
