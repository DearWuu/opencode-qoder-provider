#!/usr/bin/env node
/**
 * Verify the model catalog against the real Qoder CLI.
 *
 * This helper talks to the logged-in Qoder account to read `--list-models`
 * (a free call, it does not run a model and does not consume Credits) and prints
 * the OpenCode model IDs the plugin would register.
 *
 * Usage: node scripts/check-real-catalog.mjs [path/to/qoderclicn]
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
