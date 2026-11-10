/**
 * 文件职责：Qoder 模型名 ↔ OpenCode 模型 ID 的映射与模型目录构建。
 * 上游：index.ts 模型发现、src/catalog、scripts/check-real-catalog.mjs。
 * 下游：无（纯字符串处理）。
 *
 * 契约：OpenCode ID 是 lowercase kebab-case；`modelID` 保留 CLI 原值（`Auto`、`Qwen3.8-Max`），
 * 这样才能原样传给 `--model`。
 */

/** 把 Qoder 模型名转成 OpenCode（lowercase kebab-case）模型 ID。 */
export function toModelId(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

/**
 * 解析 `qoderclicn --list-models` 的输出。
 *
 * CLI 先打印 `MODEL` 表头，再每行一个模型；非内置 `qoder` 来源的模型
 * 以 `display (key)` 形式打印。
 */
export function parseModelList(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const entries = []
  for (const line of lines) {
    if (entries.length === 0 && line.toUpperCase() === "MODEL") continue
    entries.push(parseModelEntry(line))
  }
  return entries
}

/** 把一行 `--list-models` 输出拆成展示名与模型 key。 */
export function parseModelEntry(line) {
  const match = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(line)
  if (match && match[1].trim().length > 0) {
    return { name: match[1].trim(), modelID: match[2].trim() }
  }
  return { name: line, modelID: line }
}

/**
 * 由 Qoder 模型列表构建 OpenCode 模型目录。
 * 重复 ID（两个 Qoder 名归一化后相同）会追加数字后缀区分。
 *
 * 调用方：index.ts 的 discover、scripts/check-real-catalog.mjs。
 */
export function buildModelCatalog(entries) {
  const used = new Map()
  return entries.map((entry) => {
    const base = toModelId(entry.modelID) || toModelId(entry.name) || "model"
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    const id = seen === 0 ? base : `${base}-${seen + 1}`
    return { id, modelID: entry.modelID, name: entry.name }
  })
}
