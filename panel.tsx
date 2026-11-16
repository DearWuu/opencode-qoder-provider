/** @jsxImportSource @opentui/solid */
/**
 * 文件职责：TUI 侧边栏的 Qoder Credits 面板（@opentui/solid 组件）：CN 与海外两个变体各一段，
 * 展示本地 Today、官方 `/usage` 额度与每模型倍率。
 * 上游：tui.ts 挂载到 sidebar.content slot。
 * 下游：src/credits.creditsPanelLines、src/pricing.pricingPanelLines、src/panel-model.createCreditsPanelController、
 *       src/poller.createStatsPoller、rpc.ts（stats/quota/pricing）、src/variants（变体清单）。
 */
import { For, createMemo, createSignal, onCleanup } from "solid-js"

import type { Context } from "@opencode/plugin/tui/context"

import { creditsPanelLines, panelFooterLines } from "./src/credits.mjs"
import { pricingPanelLines } from "./src/pricing.mjs"
import { createCreditsPanelController } from "./src/panel-model.mjs"
import { createStatsPoller } from "./src/poller.mjs"
import { VARIANT_IDS, getVariant } from "./src/variants.mjs"
import { QoderRpc } from "./rpc.ts"
import type { QoderPricingOutput, QoderQuotaOutput, QoderStatsOutput } from "./rpc.ts"

interface CreditsPanelProps {
  context: Context
  /** 打开对应变体的完整 `/qoder <variant> status` 对话框；由 TUI 插件接线。 */
  onStatus: (variantId: string) => Promise<void> | void
}

type PanelLine = {
  tone: "base" | "muted" | "warning"
  text: string
  action?: "toggle-pricing" | "refresh"
}

/**
 * 侧边栏常驻的 "Qoder Credits" 面板（CN + 海外两段）。
 *
 * Today 每 15 秒只读本地日志。quota 与 pricing RPC 命中服务端内存缓存，
 * 只有挂载、TTL 到期或用户主动 status/refresh 才读取外部来源，不产生模型调用。
 */
export function QoderCreditsPanel(props: CreditsPanelProps) {
  const theme = props.context.theme
  const sections = VARIANT_IDS.map((variantId) => createVariantSection(props, variantId))

  return (
    <box id="sidebar.qoder-credits" flexDirection="column" gap={0}>
      <For each={sections}>
        {(section, index) => (
          <>
            <text
              id={`sidebar.qoder-credits.${section.id}.title`}
              fg={theme.text.base}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                void props.onStatus(section.id)
              }}
            >
              <b>{section.name}</b>
            </text>
            <For each={section.lines()}>
              {(line, lineIndex) => (
                <text
                  id={`sidebar.qoder-credits.${section.id}.line.${lineIndex()}`}
                  fg={toneColor(theme, line.tone)}
                  onMouseUp={(event) => {
                    if (!line.action) return
                    if (event.button !== 0) return
                    event.stopPropagation()
                    section.activate(line.action)
                  }}
                >
                  {line.text}
                </text>
              )}
            </For>
            {index() < sections.length - 1 ? <text id={`sidebar.qoder-credits.${section.id}.gap`}> </text> : null}
          </>
        )}
      </For>
    </box>
  )
}

/**
 * 一个变体对应的面板小节：独立的状态控制器、轮询与面板行。
 *
 * @param {CreditsPanelProps} props
 * @param {string} variantId
 */
function createVariantSection(props: CreditsPanelProps, variantId: string) {
  const variant = getVariant(variantId)
  const controller = createCreditsPanelController({
    fetchStats: async () =>
      (await props.context.client.rpc(QoderRpc).stats({ variant: variantId })) as QoderStatsOutput,
    fetchQuota: async ({ refresh }) =>
      (await props.context.client.rpc(QoderRpc).quota({ variant: variantId, refresh })) as QoderQuotaOutput,
    fetchPricing: async ({ refresh }) =>
      (await props.context.client.rpc(QoderRpc).pricing({ variant: variantId, refresh })) as QoderPricingOutput,
  })
  const [state, setState] = createSignal(controller.getState())
  const unsubscribe = controller.subscribe(() => setState(controller.getState()))
  onCleanup(unsubscribe)

  const poller = createStatsPoller({ fetch: () => controller.load() })
  poller.start()
  onCleanup(() => poller.stop())

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

  return {
    id: variant.id,
    name: variant.name,
    lines,
    activate(action: string) {
      if (action === "toggle-pricing") controller.togglePricing()
      else if (action === "refresh") void controller.refresh()
    },
  }
}

function toneColor(theme: Context["theme"], tone: "base" | "muted" | "warning"): string {
  if (tone === "warning") return (theme.text.feedback?.warning?.base ?? theme.text.muted) as string
  if (tone === "base") return theme.text.base as string
  return theme.text.muted as string
}

export default QoderCreditsPanel
