/**
 * 文件职责：`qoder` RPC 契约定义（execute/stats/quota 方法的输入输出 schema）与返回类型。
 * 上游：index.ts `ctx.rpc.register` 注册实现，tui.ts 与 panel.tsx 经 client.rpc 调用。
 * 下游：无（纯契约与类型，不依赖其他模块）。
 */
import { Rpc } from "@opencode/plugin/rpc"

/**
 * Qoder RPC 契约的 id。HTTP 路由为 `POST /api/rpc/qoder/<method>`。
 */
export const QODER_RPC_ID = "qoder"

/**
 * 服务端（实现方法）与 TUI 侧（调用方法）之间的类型化契约。
 *
 * `stats` 只聚合本地日志；`quota` 通过官方 CLI `/usage` 低频读取账户额度。
 * 两者都不运行模型；插件自身不直接访问账户 HTTP API。
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
    quota: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        required: [],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          source: { type: "string" },
          used: { type: "number" },
          total: { type: "number" },
          remaining: { type: "number" },
          percentage: { type: "integer" },
          expiresAt: { type: "string" },
          fetchedAt: { type: "string" },
          cached: { type: "boolean" },
          error: { type: "string" },
        },
        required: [
          "available",
          "source",
          "used",
          "total",
          "remaining",
          "percentage",
          "expiresAt",
          "fetchedAt",
          "cached",
          "error",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {},
})

/** `execute` 方法的入参。 */
export interface QoderExecuteInput {
  text: string
}

/** `execute` 方法的返回值。 */
export interface QoderExecuteOutput {
  text: string
}

/**
 * `stats` 方法的返回值：本地累计消耗。
 *
 * 每个字段恒存在且非 null：未知字符串为 `""`，未知数值为 `0`。
 * `lastAt === ""` 表示"还没有调用"。
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

/** `quota` 方法的返回值；available=false 时数值字段仅为占位，UI 不得展示为额度。 */
export interface QoderQuotaOutput {
  available: boolean
  source: string
  used: number
  total: number
  remaining: number
  percentage: number
  expiresAt: string
  fetchedAt: string
  cached: boolean
  error: string
}
