import { Rpc } from "@opencode/plugin/rpc"

/**
 * Id of the Qoder RPC contract. The HTTP route is `POST /api/rpc/qoder/<method>`.
 */
export const QODER_RPC_ID = "qoder"

/**
 * Typed contract between the server part (which implements `execute`) and the
 * TUI part (which calls it).
 *
 * The method only builds local status text: it never runs a model and never
 * touches the Qoder account.
 */
export const QoderRpc = Rpc.define({
  id: QODER_RPC_ID,
  methods: {
    execute: {
      input: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

/** Input of the `execute` method. */
export interface QoderExecuteInput {
  text: string
}

/** Output of the `execute` method. */
export interface QoderExecuteOutput {
  text: string
}
