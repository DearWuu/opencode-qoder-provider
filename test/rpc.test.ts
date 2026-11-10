import { test } from "node:test"
import assert from "node:assert/strict"

import { QODER_RPC_ID, QoderRpc } from "../rpc.ts"

test("the RPC contract is the qoder contract with the execute and stats methods", () => {
  assert.equal(QODER_RPC_ID, "qoder")
  assert.equal(QoderRpc.id, "qoder")
  assert.deepEqual(Object.keys(QoderRpc.methods), ["execute", "stats"])
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
  // Every field is required and nullable unions are forbidden: unknown
  // values arrive as "" or 0, so panel rendering cannot hit undefined.
  assert.deepEqual(output.required, Object.keys(output.properties))
  for (const [name, schema] of Object.entries(output.properties)) {
    assert.equal(typeof schema.type, "string", `${name} must be a single non-null type`)
  }
  assert.equal(output.properties.models.type, "integer")
  assert.equal(output.properties.totalCredits.type, "number")
  assert.equal(output.properties.authenticated.type, "boolean")
  assert.equal(output.properties.lastAt.type, "string")
})

test("the RPC contract declares no events", () => {
  assert.deepEqual(Object.keys(QoderRpc.events), [])
})
