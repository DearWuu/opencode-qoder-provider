import { Rpc } from "@opencode/plugin/rpc"

/**
 * Id of the Qoder RPC contract. The HTTP route is `POST /api/rpc/qoder/<method>`.
 */
export const QODER_RPC_ID = "qoder"

/**
 * Typed contract between the server part (which implements the methods) and
 * the TUI part (which calls them).
 *
 * Both methods only read local state: `execute` builds status text, `stats`
 * aggregates the call log. Neither runs a model nor touches the network.
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
    stats: {
      input: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          provider: { type: "string" },
          models: { type: "integer" },
          authenticated: { type: "boolean" },
          permissionMode: { type: "string" },
          cliVersion: { type: "string" },
          totalCalls: { type: "integer" },
          totalCredits: { type: "number" },
          todayCalls: { type: "integer" },
          todayCredits: { type: "number" },
          lastModel: { type: "string" },
          lastCredits: { type: "number" },
          lastAt: { type: "string" },
          lastError: { type: "boolean" },
        },
        required: [
          "provider",
          "models",
          "authenticated",
          "permissionMode",
          "cliVersion",
          "totalCalls",
          "totalCredits",
          "todayCalls",
          "todayCredits",
          "lastModel",
          "lastCredits",
          "lastAt",
          "lastError",
        ],
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

/**
 * Output of the `stats` method: locally accumulated consumption.
 *
 * Every field is always present and never null: unknown strings are `""`,
 * unknown numbers are `0`. `lastAt === ""` means "no calls yet".
 */
export interface QoderStatsOutput {
  provider: string
  models: number
  authenticated: boolean
  permissionMode: string
  cliVersion: string
  totalCalls: number
  totalCredits: number
  todayCalls: number
  todayCredits: number
  lastModel: string
  lastCredits: number
  lastAt: string
  lastError: boolean
}
