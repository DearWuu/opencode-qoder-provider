/** @jsxImportSource @opentui/solid */
/**
 * 文件职责：TUI 侧边栏 Qoder Credits 面板（@opentui/solid 组件），展示本地 Today、官方 `/usage` 额度与每模型倍率。
 * 上游：tui.ts 挂载到 sidebar.content slot。
 * 下游：src/credits.creditsPanelLines、src/pricing.pricingPanelLines、src/poller.createStatsPoller、rpc.ts（stats/quota/pricing）。
 */
import { For, createMemo, createSignal, onCleanup } from "solid-js"

import type { Context } from "@opencode/plugin/tui/context"

import { creditsPanelLines, panelFooterLines } from "./src/credits.mjs"
import { pricingPanelLines } from "./src/pricing.mjs"
import { createCreditsPanelController } from "./src/panel-model.mjs"
import { createStatsPoller } from "./src/poller.mjs"
import { QoderRpc } from "./rpc.ts"
import type { QoderPricingOutput, QoderQuotaOutput, QoderStatsOutput } from "./rpc.ts"

interface CreditsPanelProps {
  context: Context
  /** 打开完整的 `/qoder status` 对话框；由 TUI 插件接线。 */
  onStatus: () => Promise<void> | void
}

type PanelLine = {
  tone: "base" | "muted" | "warning"
  text: string
  action?: "toggle-pricing" | "refresh"
}

/**
 * 侧边栏常驻的 "Qoder Credits" 面板。
 *
 * Today 每 15 秒只读本地日志。quota 与 pricing RPC 命中服务端内存缓存，
 * 只有挂载、TTL 到期或用户主动 status/refresh 才读取外部来源，不产生模型调用。
 */
export function QoderCreditsPanel(props: CreditsPanelProps) {
  const theme = props.context.theme
  const controller = createCreditsPanelController({
    fetchStats: async () =>
      (await props.context.client.rpc(QoderRpc).stats({})) as QoderStatsOutput,
    fetchQuota: async ({ refresh }) =>
      (await props.context.client.rpc(QoderRpc).quota({ refresh })) as QoderQuotaOutput,
    fetchPricing: async ({ refresh }) =>
      (await props.context.client.rpc(QoderRpc).pricing({ refresh })) as QoderPricingOutput,
  })
  const [state, setState] = createSignal(controller.getState())
  const unsubscribe = controller.subscribe(() => setState(controller.getState()))
  onCleanup(unsubscribe)

  const poller = createStatsPoller({ fetch: () => controller.load() })
  poller.start()
  onCleanup(() => poller.stop())

  const activate = (action: string) => {
    if (action === "toggle-pricing") controller.togglePricing()
    else if (action === "refresh") void controller.refresh()
  }

  const lines = createMemo<PanelLine[]>(() => [
    ...creditsPanelLines({
      stats: state().stats,
      quota: state().quota,
      error: state().error,
      quotaError: state().quotaError,
      nowMs: state().nowMs,
    }),
    ...pricingPanelLines({
      pricing: state().pricing,
      nowMs: state().nowMs,
      collapsed: state().collapsed,
    }),
    ...panelFooterLines({ refreshing: state().refreshing }),
  ])

  return (
    <box id="sidebar.qoder-credits" flexDirection="column" gap={0}>
      <text
        id="sidebar.qoder-credits.title"
        fg={theme.text.base}
        onMouseUp={(event) => {
          if (event.button !== 0) return
          void (async () => {
            await props.onStatus()
            await controller.reload()
          })()
        }}
      >
        <b>Qoder Credits</b>
      </text>
      <For each={lines()}>
        {(line, index) => (
          <text
            id={`sidebar.qoder-credits.line.${index()}`}
            fg={toneColor(theme, line.tone)}
            onMouseUp={(event) => {
              if (!line.action) return
              if (event.button !== 0) return
              event.stopPropagation()
              activate(line.action)
            }}
          >
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
