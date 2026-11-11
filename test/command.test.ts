/**
 * 文件职责：`/qoder models` 与 `/qoder status` 的倍率、促销态文案测试。
 * 上游：node:test / Bun test。
 * 下游：src/command.mjs；只读本地空日志，不联网、不调用模型。
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { buildModelsText, buildStatusText } from "../src/command.mjs"

const NOW_MS = Date.parse("2026-11-11T10:00:00.000Z")
// 2026-11-12 07:30 Asia/Shanghai：距离 08:00 结束还有 30 分钟。
const ACTIVE_NOW_MS = Date.parse("2026-11-11T23:30:00.000Z")
// 2026-11-11 21:00 Asia/Shanghai：距离 22:00 开始还有 1 小时。
const UPCOMING_NOW_MS = Date.parse("2026-11-11T13:00:00.000Z")

const OPTIONS = {
  cliPath: "qoderclicn",
  permissionMode: "bypass_permissions",
  timeoutMs: 1_800_000,
  idleTimeoutMs: 180_000,
  logFile: "",
  cwd: undefined,
}

const CATALOG = [
  { id: "glm-5-3", modelID: "GLM-5.3", name: "GLM-5.3" },
  { id: "auto", modelID: "Auto", name: "Auto" },
]

const PRICING = {
  models: [
    {
      modelKey: "GLM-5.3",
      priceFactor: 0.1,
      originalPriceFactor: 0.5,
      promotion: {
        active: true,
        beforePromotionPriceFactor: 0.5,
        windowStart: "22:00",
        windowEnd: "08:00",
        timezone: "Asia/Shanghai",
        badge: "错峰 4 折",
      },
    },
  ],
  fetchedAt: "2026-11-11T10:00:00.000Z",
  source: "fixture",
}

test("/qoder models appends the factor and promotion only to matched models", () => {
  const text = buildModelsText(CATALOG, undefined, PRICING, ACTIVE_NOW_MS)
  assert.match(text, /- qoder\/glm-5-3\s+GLM-5\.3\s+0\.10x 低峰 · 30 分后恢复 0\.50x/)
  assert.match(text, /- qoder\/auto\s+Auto$/)
})

test("/qoder models keeps its original lines without a pricing snapshot", () => {
  const text = buildModelsText(CATALOG, undefined, null, NOW_MS)
  assert.match(text, /- qoder\/glm-5-3\s+GLM-5\.3(?:\n|$)/)
  assert.match(text, /- qoder\/auto\s+Auto$/)
  assert.equal(/0\.10x/.test(text), false)
})

test("/qoder status adds a Pricing summary while the low-peak window is active", () => {
  const text = buildStatusText(OPTIONS, CATALOG, undefined, "1.1.85", PRICING, ACTIVE_NOW_MS)
  assert.match(text, /- Models: 2/)
  assert.match(text, /- Pricing: 低峰进行中，30 分后恢复 0\.50x/)
})

test("/qoder status counts down to the next daily low-peak window and shows its badge", () => {
  const pricing = {
    models: [
      {
        modelKey: "GLM-5.3",
        priceFactor: 0.5,
        promotion: {
          active: false,
          discountFactor: 0.4,
          windowStart: "22:00",
          windowEnd: "08:00",
          timezone: "Asia/Shanghai",
          badge: "错峰 4 折",
        },
      },
    ],
    fetchedAt: "2026-11-11T10:00:00.000Z",
    source: "fixture",
  }
  const text = buildStatusText(OPTIONS, CATALOG, undefined, "1.1.85", pricing, UPCOMING_NOW_MS)
  assert.match(text, /- Pricing: 1 小时 0 分后进入错峰 4 折/)
})

test("/qoder status omits the Pricing line when no snapshot exists", () => {
  const text = buildStatusText(OPTIONS, CATALOG, undefined, "1.1.85", null, NOW_MS)
  assert.equal(/Pricing:/.test(text), false)
})
