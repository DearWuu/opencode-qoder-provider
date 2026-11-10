/** @jsxImportSource @opentui/solid */
import { For, createMemo, createSignal, onCleanup } from "solid-js"

import type { Context } from "@opencode/plugin/tui/context"

import { createStatsPoller, creditsPanelLines } from "./src/credits.mjs"
import { QoderRpc } from "./rpc.ts"
import type { QoderStatsOutput } from "./rpc.ts"

interface CreditsPanelProps {
  context: Context
  /** Opens the full `/qoder status` dialog; wired by the TUI plugin. */
  onStatus: () => Promise<void> | void
}

/**
 * Persistent "Qoder Credits" panel in the TUI sidebar.
 *
 * The numbers are the locally accumulated consumption from the call log,
 * read through the `stats` RPC: never an account balance, never a model
 * call, never a network request. The panel refreshes on a fixed interval
 * and folds a failed poll into a single muted error line.
 */
export function QoderCreditsPanel(props: CreditsPanelProps) {
  const theme = props.context.theme
  const [stats, setStats] = createSignal<QoderStatsOutput | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [nowMs, setNowMs] = createSignal(Date.now())

  const poller = createStatsPoller({
    fetch: async () => {
      try {
        const value = (await props.context.client.rpc(QoderRpc).stats({})) as QoderStatsOutput
        setStats(value)
        setError(undefined)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setNowMs(Date.now())
      }
    },
  })
  poller.start()
  onCleanup(() => poller.stop())

  const lines = createMemo(() => creditsPanelLines({ stats: stats(), error: error(), nowMs: nowMs() }))

  return (
    <box id="sidebar.qoder-credits" flexDirection="column" gap={0}>
      <text
        id="sidebar.qoder-credits.title"
        fg={theme.text.base}
        onMouseUp={(event) => {
          if (event.button !== 0) return
          void props.onStatus()
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
