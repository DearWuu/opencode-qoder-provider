/**
 * 文件职责：跨 location 同步 Qoder 模型目录：任一 location refresh 成功后，把新目录广播给所有已加载 location。
 * 上游：index.ts（每个 location 的插件实例各建立一个同步句柄）。
 * 下游：无（进程内发布/订阅；不依赖 @opencode/plugin）。
 *
 * OpenCode 会为每个 location 重新求值一份插件模块，模块顶层变量因此不跨 location 共享。
 * 注册表挂在 globalThis 上并以 Symbol.for 取键，保证同一服务进程内所有 location 的模块实例
 * 访问到同一份订阅者列表。
 */

/** 进程级注册表键：同一键名在多次模块求值之间稳定。 */
const REGISTRY_KEY = Symbol.for("opencode-qoder-provider.catalog-sync.v1")

/** 默认发布域：本插件在服务端只有一份目录同步逻辑。 */
export const DEFAULT_SYNC_SCOPE = "qoder"

const SKIPPED = Object.freeze({ broadcast: false, delivered: 0, failed: 0 })

/**
 * @typedef {{ id: string, modelID: string, name: string }} CatalogEntry
 * @typedef {{ location: string, apply: (catalog: CatalogEntry[]) => unknown }} Subscriber
 * @typedef {{ subscribers: Set<Subscriber>, lastSignature?: string, pendingSignature?: string, tail: Promise<void> }} Registry
 */

/**
 * 取进程级注册表中的发布域；不存在时创建。
 *
 * @param {string} scope
 * @returns {Registry}
 */
function registryFor(scope) {
  const root = (globalThis[REGISTRY_KEY] ??= new Map())
  let registry = root.get(scope)
  if (!registry) {
    registry = { subscribers: new Set(), tail: Promise.resolve() }
    root.set(scope, registry)
  }
  return registry
}

/**
 * 目录签名：用于识别重复发布，避免同一份目录触发多次 reload。
 *
 * @param {CatalogEntry[]} catalog
 * @returns {string}
 */
export function catalogSignature(catalog) {
  return JSON.stringify(catalog.map((entry) => [entry.id, entry.modelID, entry.name]))
}

/**
 * 把一个 location 的本地目录状态接入同步域。
 *
 * 返回的 `publish` 在某个 location refresh 成功后调用；`dispose` 在插件卸载时调用。
 * 发布按登记顺序串行执行，单个订阅者抛错不影响其他订阅者。
 *
 * @param {{ location?: string, apply: (catalog: CatalogEntry[]) => unknown, scope?: string }} options
 * @returns {{ publish: (catalog: CatalogEntry[]) => Promise<{ broadcast: boolean, delivered: number, failed: number }>, dispose: () => void }}
 */
export function createCatalogSync({ location, apply, scope = DEFAULT_SYNC_SCOPE }) {
  const registry = registryFor(scope)
  let active = true
  /** @type {Subscriber} */
  const subscriber = { location: String(location ?? ""), apply }
  registry.subscribers.add(subscriber)

  /**
   * 广播一份已成功发现的目录。
   *
   * 与上一次已发布（或正在排队发布）的目录签名相同时直接跳过：目录没变就不需要 reload。
   * 队列只在发布过程中保持，不跨发布累积。
   *
   * @param {CatalogEntry[]} catalog
   */
  const publish = (catalog) => {
    if (!active) return Promise.resolve(SKIPPED)
    if (!Array.isArray(catalog) || catalog.length === 0) {
      throw new Error("Refusing to broadcast an empty Qoder model catalog.")
    }

    const signature = catalogSignature(catalog)
    if (signature === registry.lastSignature || signature === registry.pendingSignature) {
      return Promise.resolve(SKIPPED)
    }
    registry.pendingSignature = signature

    const run = async () => {
      registry.pendingSignature = undefined
      registry.lastSignature = signature
      const targets = [...registry.subscribers]
      const results = await Promise.allSettled(
        targets.map((target) => Promise.resolve().then(() => target.apply(catalog))),
      )
      const failed = results.filter((result) => result.status === "rejected").length
      return { broadcast: true, delivered: targets.length - failed, failed }
    }

    const queued = registry.tail.then(run, run)
    registry.tail = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  const dispose = () => {
    active = false
    registry.subscribers.delete(subscriber)
  }

  return { publish, dispose }
}
