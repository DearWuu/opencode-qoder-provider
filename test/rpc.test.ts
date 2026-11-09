import { test } from "node:test"
import assert from "node:assert/strict"

import { QODER_RPC_ID, QoderRpc } from "../rpc.ts"

test("the RPC contract is the qoder contract with a single execute method", () => {
  assert.equal(QODER_RPC_ID, "qoder")
  assert.equal(QoderRpc.id, "qoder")
  assert.deepEqual(Object.keys(QoderRpc.methods), ["execute"])
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

test("the RPC contract declares no events", () => {
  assert.deepEqual(Object.keys(QoderRpc.events), [])
})
