/** @jsxImportSource @opentui/solid */
/**
 * 文件职责：TUI 侧边栏 Qoder Credits 面板（@opentui/solid 组件），展示本地 Today 与官方 `/usage` 额度。
 * 上游：tui.ts 挂载到 sidebar.content slot。
 * 下游：src/credits.creditsPanelLines、src/poller.createStatsPoller、rpc.ts（stats 本地日志 / quota TTL 缓存）。
 */
import { For, createMemo, createSignal, onCleanup } from "solid-js"

import type { Context } from "@opencode/plugin/tui/context"

import { creditsPanelLines } from "./src/credits.mjs"
import { createStatsPoller } from "./src/poller.mjs"
import { QoderRpc } from "./rpc.ts"
import type { QoderQuotaOutput, QoderStatsOutput } from "./rpc.ts"

interface CreditsPanelProps {
  context: Context
  /** 打开完整的 `/qoder status` 对话框；由 TUI 插件接线。 */
  onStatus: () => Promise<void> | void
}

/**
 * 侧边栏常驻的 "Qoder Credits" 面板。
 *
 * Today 每 15 秒只读本地日志。quota RPC 命中服务端 5 分钟内存缓存，
 * 只有挂载、TTL 到期或用户主动 status/refresh 才读取官方 CLI，不产生模型调用。
 */
export function QoderCreditsPanel(props: CreditsPanelProps) {
  const theme = props.context.theme
  const [stats, setStats] = createSignal<QoderStatsOutput | undefined>(undefined)
  const [quota, setQuota] = createSignal<QoderQuotaOutput | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [quotaError, setQuotaError] = createSignal<string | undefined>(undefined)
  const [nowMs, setNowMs] = createSignal(Date.now())

  const fetchStats = async () => {
    try {
      const value = (await props.context.client.rpc(QoderRpc).stats({})) as QoderStatsOutput
      setStats(value)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const fetchQuota = async () => {
    try {
      const value = (await props.context.client.rpc(QoderRpc).quota({ refresh: false })) as QoderQuotaOutput
      setQuota(value)
      setQuotaError(undefined)
    } catch (cause) {
      // 配额错误只降级面板，不用 toast 打断用户。
      setQuotaError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const poller = createStatsPoller({
    fetch: async () => {
      await Promise.all([fetchStats(), fetchQuota()])
      setNowMs(Date.now())
    },
  })
  poller.start()
  onCleanup(() => poller.stop())

  const lines = createMemo(() => creditsPanelLines({
    stats: stats(),
    quota: quota(),
    error: error(),
    quotaError: quotaError(),
    nowMs: nowMs(),
  }))

  return (
    <box id="sidebar.qoder-credits" flexDirection="column" gap={0}>
      <text
        id="sidebar.qoder-credits.title"
        fg={theme.text.base}
        onMouseUp={(event) => {
          if (event.button !== 0) return
          void (async () => {
            await props.onStatus()
            await fetchQuota()
            setNowMs(Date.now())
          })()
        }}
      >
        <b>Qoder Credits</b>
      </text>
      <For each={lines()}>
        {(line, index) => (
          <text id={`sidebar.qoder-credits.line.${index()}`} fg={toneColor(theme, line.tone)}>
            {line.text}
          </text>
        )}
      </For>
    </box>
  )
}

function toneColor(theme: Context["theme"], tone: "base" | "muted" | "warning"): string {
  if (tone === "warning") return (theme.text.feedback?.warning?.base ?? theme.text.muted) as string
  if (tone === "base") return theme.text.base as string
  return theme.text.muted as string
}

export default QoderCreditsPanel
