/**
 * 文件职责：作为 Node 桥接入口执行一次官方 `/usage` 读取，并把原始屏幕或错误编码为 JSON。
 * 上游：src/quota-cli.readOfficialUsageViaNode（Bun 运行时无法直接使用 node-pty）。
 * 下游：src/quota-cli.readOfficialUsage；仅接收 stdin 请求，不访问账户网络 API。
 */
import { readFileSync } from "node:fs"

import { readOfficialUsage } from "./quota-cli.mjs"

let request
try {
  request = JSON.parse(readFileSync(0, "utf8"))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: `Invalid quota bridge request: ${errorMessage(error)}` }))
  process.exitCode = 1
}

if (request) {
  try {
    const output = await readOfficialUsage(request)
    process.stdout.write(JSON.stringify({ ok: true, output }))
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: errorMessage(error) }))
    process.exitCode = 1
  }
}

function errorMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 300) || "Unknown quota bridge error."
}
