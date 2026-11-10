import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

import { QoderCreditsPanel } from "./panel.tsx"
import { parseSubcommand } from "./src/command.mjs"
import { QoderRpc } from "./rpc.ts"
import type { QoderExecuteOutput } from "./rpc.ts"

const TUI_PLUGIN_ID = "opencode-qoder-provider.cli"

/**
 * TUI part of the Qoder plugin.
 *
 * It registers the `/qoder` slash command in the prompt and the persistent
 * credits panel in the sidebar. The command calls the server through the
 * `qoder` RPC contract and shows the result in a native dialog, so the
 * answer is visible right away instead of waiting in the session inbox.
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
 * Run one `/qoder ...` invocation and show the result.
 *
 * The command is local: the server side only builds status text, so no model
 * call and no Qoder credit is spent.
 *
 * @param {Context} context
 * @param {string} input raw arguments of the slash command, e.g. "status"
 * @returns {Promise<void>}
 */
export async function runQoderCommand(context: Context, input: string): Promise<void> {
  try {
    // Read the client where it is used: it is replaced when the server restarts.
    const result = await context.client.rpc(QoderRpc).execute({ text: input })
    const text = (result as QoderExecuteOutput).text
    await context.ui.dialog.alert({ title: "Qoder", message: text })
    if (parseSubcommand(input) === "refresh") {
      // The catalog may have changed: refresh the model list of the picker.
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
