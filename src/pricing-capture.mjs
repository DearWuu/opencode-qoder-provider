/**
 * 文件职责：注入 Qoder CLI 进程的捕获 hook：包装 `JSON.parse`，把含 `price_factor` 的解密明文写到约定目录。
 * 上游：src/pricing-qoder.mjs 经 NODE_OPTIONS `--import` 加载；只在设置了 QODER_PRICING_CAPTURE_DIR 时生效。
 * 下游：node:fs。
 *
 * 该文件必须保持零依赖与无副作用（未设置环境变量时什么都不做），避免影响 CLI 自身启动。
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const directory = process.env.QODER_PRICING_CAPTURE_DIR

if (directory) {
  let sequence = 0
  const originalParse = JSON.parse
  JSON.parse = function capturePricing(text, reviver) {
    const result = originalParse.call(this, text, reviver)
    try {
      if (result && typeof result === "object") {
        const serialized = JSON.stringify(result)
        if (serialized.includes('"price_factor"') || serialized.includes('"priceFactor"')) {
          mkdirSync(directory, { recursive: true })
          writeFileSync(
            join(directory, `capture-${++sequence}.json`),
            typeof text === "string" ? text : serialized,
          )
        }
      }
    } catch {
      // 捕获失败不能影响 CLI 的解析结果。
    }
    return result
  }
}
