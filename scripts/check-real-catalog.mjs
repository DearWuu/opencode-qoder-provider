#!/usr/bin/env node
/**
 * 文件职责：用真实 Qoder 账号校验模型目录（人工运行：node scripts/check-real-catalog.mjs [变体] [cli 路径]）。
 * 上游：`npm run check:catalog` 或人工执行；不进入自动化测试与 CI。
 * 下游：src/catalog、src/models、src/variants。
 *
 * `--list-models` 不跑模型、不消耗 Credits。脚本打印插件会注册的 OpenCode 模型 ID。
 */
import { fetchModelList } from "../src/catalog.mjs"
import { buildModelCatalog } from "../src/models.mjs"
import { DEFAULT_VARIANT_ID, getVariant, isVariantId, resolveVariantCliPath } from "../src/variants.mjs"

const [variantArg, cliArg] = process.argv.slice(2)
const variantId = isVariantId(variantArg) ? variantArg : DEFAULT_VARIANT_ID
const variant = getVariant(variantId)
const cliPath = cliArg ?? resolveVariantCliPath(variantId)
const entries = await fetchModelList({ cliPath, timeoutMs: 120_000 })
const catalog = buildModelCatalog(entries)

console.log(`CLI: ${cliPath}`)
console.log(`${variant.name} (${variant.id}) — ${catalog.length} models:`)
for (const entry of catalog) {
  console.log(`- ${variant.id}/${entry.id}  ->  ${entry.name} (modelID: ${entry.modelID})`)
}
