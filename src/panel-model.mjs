/**
 * 文件职责：Credits 面板的可测状态机：stats/quota/pricing 取数、手动刷新（含防重复与失败保留）、折叠开关。
 * 上游：panel.tsx 创建控制器并把状态映射到 Solid signal；test/panel-model.test.ts。
 * 下游：无（取数函数由面板注入，不直接依赖 RPC/终端）。
 */

/**
 * @typedef {{
 *   stats: any,
 *   quota: any,
 *   pricing: any,
 *   error: string|undefined,
 *   quotaError: string|undefined,
 *   nowMs: number,
 *   refreshing: boolean,
 *   collapsed: boolean,
 * }} CreditsPanelState
 */

/**
 * 创建面板状态控制器。
 *
 * 每个取数函数都返回 Promise；控制器吞掉异常并按各自的降级规则更新状态，
 * 因此调用方不需要 try/catch。状态更新会通知所有订阅者（面板据此重渲染）。
 *
 * 手动刷新只在 `quota({ refresh: true })` 与 `pricing({ refresh: true })` 之间并发：
 * - 刷新中重复点击直接忽略；
 * - quota 失败且已有旧数据时保留旧数据、不显示错误；从未取到数据时沿用面板既有错误态；
 * - pricing 失败保持上一份快照（fetchedAt 不会被伪造前进）。
 *
 * @param {{
 *   fetchStats?: () => Promise<any>,
 *   fetchQuota?: (input: { refresh: boolean }) => Promise<any>,
 *   fetchPricing?: (input: { refresh: boolean }) => Promise<any>,
 *   now?: () => number,
 * }} [options]
 * @returns {{
 *   getState: () => CreditsPanelState,
 *   subscribe: (listener: () => void) => () => void,
 *   load: () => Promise<void>,
 *   reload: () => Promise<void>,
 *   refresh: () => Promise<boolean>,
 *   togglePricing: () => void,
 * }}
 */
export function createCreditsPanelController(options = {}) {
  const fetchStats = options.fetchStats ?? (async () => undefined)
  const fetchQuota = options.fetchQuota ?? (async () => undefined)
  const fetchPricing = options.fetchPricing ?? (async () => null)
  const now = options.now ?? Date.now

  let state = {
    stats: undefined,
    quota: undefined,
    pricing: null,
    error: undefined,
    quotaError: undefined,
    nowMs: now(),
    refreshing: false,
    collapsed: false,
  }
  const listeners = new Set()

  function setState(patch) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  async function loadStats() {
    try {
      const value = await fetchStats()
      setState({ stats: value, error: undefined })
    } catch (cause) {
      setState({ error: errorMessage(cause) })
    }
  }

  async function loadQuota({ refresh = false, keepOnError = false } = {}) {
    try {
      const value = await fetchQuota({ refresh })
      setState({ quota: value, quotaError: undefined })
    } catch (cause) {
      if (!keepOnError) setState({ quotaError: errorMessage(cause) })
    }
  }

  async function loadPricing({ refresh = false } = {}) {
    try {
      const value = await fetchPricing({ refresh })
      setState({ pricing: value ?? null })
    } catch {
      // 倍率不可用时保留上一次快照；从未取到数据则整段隐藏，不显示占位值。
    }
  }

  async function settle() {
    setState({ nowMs: now() })
  }

  /** 轮询与标题点击共用的非强制取数。 */
  async function load() {
    await Promise.all([loadStats(), loadQuota(), loadPricing()])
    await settle()
  }

  /** 打开 `/qoder status` 后重新读取 quota 与 pricing（不强制外部刷新）。 */
  async function reload() {
    await Promise.all([loadQuota(), loadPricing()])
    await settle()
  }

  /** 手动强制刷新 quota 与 pricing；刷新中重复调用返回 false 且不发起新请求。 */
  async function refresh() {
    if (state.refreshing) return false
    setState({ refreshing: true })
    try {
      await Promise.all([
        loadQuota({ refresh: true, keepOnError: state.quota !== undefined }),
        loadPricing({ refresh: true }),
      ])
      await settle()
      return true
    } finally {
      setState({ refreshing: false })
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    reload,
    refresh,
    togglePricing() {
      setState({ collapsed: !state.collapsed })
    },
  }
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause)
}
