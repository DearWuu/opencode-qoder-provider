#!/usr/bin/env node
/**
 * 文件职责：用真实 Qoder 账号校验模型目录（人工运行：node scripts/check-real-catalog.mjs [cli 路径]）。
 * 上游：`npm run check:catalog` 或人工执行；不进入自动化测试与 CI。
 * 下游：src/catalog、src/models、src/options。
 *
 * `--list-models` 不跑模型、不消耗 Credits。脚本打印插件会注册的 OpenCode 模型 ID。
 */
import { fetchModelList } from "../src/catalog.mjs"
import { buildModelCatalog } from "../src/models.mjs"
import { bundledCliPath } from "../src/options.mjs"

const cliPath = process.argv[2] ?? bundledCliPath() ?? "qoderclicn"
const entries = await fetchModelList({ cliPath, timeoutMs: 120_000 })
const catalog = buildModelCatalog(entries)

console.log(`CLI: ${cliPath}`)
console.log(`${catalog.length} models:`)
for (const entry of catalog) {
  console.log(`- qoder/${entry.id}  ->  ${entry.name} (modelID: ${entry.modelID})`)
}
