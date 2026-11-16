/**
 * 文件职责：双变体描述符、CLI 解析顺序、命令 token 与模型引用的测试。
 * 上游：node:test / Bun test。
 * 下游：src/variants.mjs；只读文件系统与 PATH，不启动 CLI、不调用模型。
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_VARIANT_ID,
  VARIANT_CN,
  VARIANT_IDS,
  VARIANT_INTL,
  cliCommandName,
  getVariant,
  isVariantId,
  pathCommand,
  resolveVariantCliPath,
  variantCommandToken,
  variantFromToken,
  variantModelReference,
} from "../src/variants.mjs"

test("the two variants carry their own provider id and display name", () => {
  assert.deepEqual(VARIANT_IDS, ["qodercn", "qoder"])
  assert.equal(DEFAULT_VARIANT_ID, VARIANT_CN)
  assert.equal(getVariant("qodercn").name, "QoderCN (Credits)")
  assert.equal(getVariant("qoder").name, "Qoder (Credits)")
  assert.throws(() => getVariant("nope"), /Unknown Qoder variant/)
})

test("variant ids and command tokens are recognised", () => {
  assert.equal(isVariantId("qodercn"), true)
  assert.equal(isVariantId("qoder"), true)
  assert.equal(isVariantId("nope"), false)
  assert.equal(variantFromToken("cn"), "qodercn")
  assert.equal(variantFromToken("QoderCN"), "qodercn")
  assert.equal(variantFromToken("intl"), "qoder")
  assert.equal(variantFromToken("qoder"), "qoder")
  assert.equal(variantFromToken("global"), "qoder")
  assert.equal(variantFromToken("models"), undefined)
  assert.equal(variantCommandToken("qodercn"), "cn")
  assert.equal(variantCommandToken("qoder"), "intl")
  assert.equal(variantModelReference("qoder", "ultimate"), "qoder/ultimate")
})

test("the CN variant keeps the bundled CLI first and falls back to qoderclicn", () => {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url))
  const bundled = resolveVariantCliPath("qodercn", { raw: {}, env: {}, packageRoot })
  assert.ok(bundled.endsWith("qoderclicn.js"))
  assert.equal(existsSync(bundled), true)

  // 没有随包 CLI 时退回 PATH 上的 qoderclicn。
  const fallback = resolveVariantCliPath("qodercn", { raw: {}, env: {}, packageRoot: "/nonexistent" })
  assert.equal(fallback, "qoderclicn")
})

test("the overseas variant only looks on PATH: qodercli first, then qoder", () => {
  const path = resolveVariantCliPath("qoder", { raw: {}, env: { PATH: "/nonexistent" }, packageRoot: "/nonexistent" })
  assert.equal(path, "qodercli")

  const cli = fileURLToPath(new URL("./fixtures/fake-qoder-intl.mjs", import.meta.url))
  const found = resolveVariantCliPath("qoder", {
    raw: {},
    env: { PATH: `${fileURLToPath(new URL("./fixtures", import.meta.url))}` },
    packageRoot: "/nonexistent",
  })
  // fixtures 目录里没有 qodercli/qoder 可执行文件时回落到首选命令名。
  assert.ok(found.endsWith("qodercli") || found.endsWith("qoder"))
  assert.equal(cli.endsWith("fake-qoder-intl.mjs"), true)
})

test("per variant options and environment variables win over the defaults", () => {
  assert.equal(
    resolveVariantCliPath("qoder", { raw: { variants: { qoder: { cliPath: "/custom/qodercli" } } }, env: {} }),
    "/custom/qodercli",
  )
  assert.equal(
    resolveVariantCliPath("qoder", { raw: {}, env: { QODER_INTL_CLI_PATH: "/env/qodercli" } }),
    "/env/qodercli",
  )
  assert.equal(
    resolveVariantCliPath("qodercn", { raw: {}, env: { QODER_CN_CLI_PATH: "/env/qoderclicn" } }),
    "/env/qoderclicn",
  )
})

test("the legacy global CLI path still points at the CN variant only", () => {
  assert.equal(
    resolveVariantCliPath("qodercn", { raw: { cliPath: "/legacy/qoderclicn" }, env: {} }),
    "/legacy/qoderclicn",
  )
  assert.equal(
    resolveVariantCliPath("qodercn", { raw: {}, env: { QODER_CLI_PATH: "/legacy/qoderclicn" } }),
    "/legacy/qoderclicn",
  )
  // 海外变体不吃旧版全局路径：那条路径指的是 CN 的 CLI。
  assert.equal(
    resolveVariantCliPath("qoder", { raw: { cliPath: "/legacy/qoderclicn" }, env: { PATH: "/nonexistent" } }),
    "qodercli",
  )
})

test("the command name drops the directory and the script extension", () => {
  assert.equal(cliCommandName("/root/.nvm/bin/qodercli"), "qodercli")
  assert.equal(cliCommandName("/plugin/node_modules/@qodercn-ai/qoderclicn/bundle/qoderclicn.js"), "qoderclicn")
  assert.equal(cliCommandName("C:\\plugin\\qoderclicn.cmd"), "qoderclicn")
  assert.equal(cliCommandName(""), "")
})

test("pathCommand returns the first existing command and falls back to the first name", () => {
  const bin = fileURLToPath(new URL("./fixtures", import.meta.url))
  assert.equal(pathCommand(["definitely-missing", "also-missing"], { PATH: bin }), "definitely-missing")
})
