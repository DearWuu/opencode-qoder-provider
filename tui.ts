/**
 * 文件职责：OpenCode TUI 插件入口：注册 `/qoder` slash 命令与侧边栏 Credits 面板。
 * 上游：OpenCode TUI 加载器调用 QoderTuiPlugin.setup。
 * 下游：panel.tsx、src/command.parseSubcommand、rpc.ts。
 */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

import { QoderCreditsPanel } from "./panel.tsx"
import { parseSubcommand } from "./src/command.mjs"
import { QoderRpc } from "./rpc.ts"
import type { QoderExecuteOutput } from "./rpc.ts"

const TUI_PLUGIN_ID = "opencode-qoder-provider.cli"

/**
 * 插件 TUI 侧：在 prompt 里注册 `/qoder` slash 命令，并在侧边栏挂常驻 Credits 面板。
 *
 * 命令经 `qoder` RPC 契约调用服务端，结果直接显示在原生 dialog 里，
 * 因此回答立刻可见，不必等它从 session inbox 冒出来。
 */
export const QoderTuiPlugin = Plugin.define({
  id: TUI_PLUGIN_ID,
  async setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "qoder.command",
          title: "Qoder provider",
          description: "Qoder provider status, model refresh, catalog and login help",
          group: "Qoder",
          palette: true,
          slash: { name: "qoder", arguments: true },
          run: async (input) => {
            await runQoderCommand(context, input ?? "")
          },
        },
      ],
    }))

    context.ui.slot({
      append: "sidebar.content",
      render: () =>
        QoderCreditsPanel({
          context,
          onStatus: () => runQoderCommand(context, "status"),
        }),
    })
  },
})

/**
 * 执行一次 `/qoder ...` 并把结果显示出来。
 *
 * 命令经服务端 RPC 执行：状态读取本地日志与官方 `/usage`，不发送模型 prompt。
 *
 * @param {Context} context
 * @param {string} input slash 命令的原始参数，例如 "status"
 * @returns {Promise<void>}
 */
export async function runQoderCommand(context: Context, input: string): Promise<void> {
  try {
    // 在使用处读取 client：服务端重启后这个 client 会被替换。
    const result = await context.client.rpc(QoderRpc).execute({ text: input })
    const text = (result as QoderExecuteOutput).text
    await context.ui.dialog.alert({ title: "Qoder", message: text })
    if (parseSubcommand(input) === "refresh") {
      // 目录可能已变化：刷新模型选择器的模型列表。
      const location = context.location ?? context.data.location.default()
      context.data.location.model.invalidate(location)
      await context.data.location.model.sync(location)
    }
  } catch (error) {
    context.ui.toast.show({
      title: "Qoder",
      message: error instanceof Error ? error.message : String(error),
      variant: "error",
    })
  }
}

export default QoderTuiPlugin
