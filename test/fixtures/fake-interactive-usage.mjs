#!/usr/bin/env node
/**
 * 文件职责：quota Node 桥接测试用的交互式 Qoder CLI 替身，只输出 trust 与录制 `/usage`。
 * 上游：test/quota-cli.test.ts；下游：仅写临时输入审计，不联网、不发送模型 prompt。
 */
import { appendFileSync, readFileSync } from "node:fs"

const argv = process.argv.slice(2)
if (argv.includes("--list-models")) {
  process.stdout.write("MODEL\nAuto\nFast\n")
  process.exit(0)
}
if (argv.includes("--version")) {
  process.stdout.write("1.1.85\n")
  process.exit(0)
}

process.stdout.write("Do you trust the files in this folder?\r\n")
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  appendFileSync(process.env.FAKE_USAGE_INPUT_LOG, `${JSON.stringify(chunk)}\n`)
  if (!chunk.includes("/usage")) return
  const body = readFileSync(process.env.FAKE_USAGE_FIXTURE, "utf8")
  process.stdout.write(`\r\n${body.replace(/\n/g, "\r\n")}`)
})
setInterval(() => {}, 1_000)