import { test } from "node:test"
import assert from "node:assert/strict"

import { QODER_RPC_ID, QoderRpc } from "../rpc.ts"

test("the RPC contract is the qoder contract with execute, stats, quota and pricing methods", () => {
  assert.equal(QODER_RPC_ID, "qoder")
  assert.equal(QoderRpc.id, "qoder")
  assert.deepEqual(Object.keys(QoderRpc.methods), ["execute", "stats", "quota", "pricing"])
})

test("the execute method takes a text and returns a text", () => {
  const method = QoderRpc.methods.execute

  assert.deepEqual(method.input, {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  })
  assert.deepEqual(method.output, {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  })
})

test("the stats method takes no input and returns the stable panel fields", () => {
  const method = QoderRpc.methods.stats

  assert.deepEqual(method.input, {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  })

  const output = method.output as unknown as {
    type: string
    properties: Record<string, { type: string }>
    required: readonly string[]
    additionalProperties: boolean
  }
  assert.equal(output.type, "object")
  assert.equal(output.additionalProperties, false)
  assert.deepEqual(Object.keys(output.properties), [
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
  ])
  // 每个字段都必填且禁止可空联合类型：未知值以 "" 或 0 到达，
  // 面板渲染就不会碰到 undefined。
  assert.deepEqual(output.required, Object.keys(output.properties))
  for (const [name, schema] of Object.entries(output.properties)) {
    assert.equal(typeof schema.type, "string", `${name} must be a single non-null type`)
  }
  assert.equal(output.properties.models.type, "integer")
  assert.equal(output.properties.totalCredits.type, "number")
  assert.equal(output.properties.authenticated.type, "boolean")
  assert.equal(output.properties.lastAt.type, "string")
})

test("the quota method exposes real values plus source, cache and error metadata", () => {
  const method = QoderRpc.methods.quota as any
  assert.deepEqual(method.input, {
    type: "object",
    properties: { refresh: { type: "boolean" } },
    required: [],
    additionalProperties: false,
  })
  const fields = ["available", "source", "used", "total", "remaining", "percentage", "expiresAt", "fetchedAt", "cached", "error"]
  assert.deepEqual(Object.keys(method.output.properties), fields)
  assert.deepEqual(method.output.required, fields)
  assert.equal(method.output.properties.available.type, "boolean")
  assert.equal(method.output.properties.percentage.type, "integer")
  assert.equal(method.output.additionalProperties, false)
})

test("the pricing method returns the snapshot contract or null", () => {
  const method = QoderRpc.methods.pricing as any
  assert.deepEqual(method.input, {
    type: "object",
    properties: { refresh: { type: "boolean" } },
    required: [],
    additionalProperties: false,
  })
  assert.equal(method.output.anyOf.length, 2)
  assert.deepEqual(method.output.anyOf[0], { type: "null" })
  const snapshot = method.output.anyOf[1]
  assert.deepEqual(snapshot.required, ["models", "fetchedAt", "source"])
  const model = snapshot.properties.models.items
  assert.deepEqual(model.required, ["modelKey", "priceFactor"])
  assert.deepEqual(Object.keys(model.properties), ["modelKey", "qoderKey", "priceFactor", "originalPriceFactor", "promotion"])
  assert.deepEqual(model.properties.promotion.required, ["active"])
  assert.deepEqual(Object.keys(model.properties.promotion.properties), [
    "active",
    "discountFactor",
    "beforePromotionPriceFactor",
    "windowStart",
    "windowEnd",
    "timezone",
    "badge",
    "description",
  ])
})

test("the RPC contract declares no events", () => {
  assert.deepEqual(Object.keys(QoderRpc.events), [])
})
