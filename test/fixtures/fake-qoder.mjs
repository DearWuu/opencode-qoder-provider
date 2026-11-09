#!/usr/bin/env node
/**
 * Fake `qoderclicn` used by the unit tests.
 *
 * It mimics the parts of the real CLI (1.1.85) the provider relies on:
 *  - `--list-models` prints a `MODEL` header followed by one line per model.
 *  - `--version` prints the CLI version.
 *  - `-p -o json` reads the prompt from stdin and prints one JSON result object.
 *
 * Behaviour is controlled through environment variables:
 *  - FAKE_QODER_RECORD   path of the file that receives {argv, stdin, stdinBytes}
 *  - FAKE_QODER_MODE     ok | error | fallback | hang | not-json | crash
 *  - FAKE_QODER_MODELS   newline separated model list for --list-models
 */
import { writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const mode = process.env.FAKE_QODER_MODE ?? "ok"

function argValue(flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

function record(payload) {
  const file = process.env.FAKE_QODER_RECORD
  if (!file) return
  writeFileSync(file, JSON.stringify(payload, null, 2))
}

if (argv.includes("--list-models")) {
  const models = (process.env.FAKE_QODER_MODELS ?? "Auto\nFast\nQwen3.8-Max")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  process.stdout.write(["MODEL", ...models].join("\n") + "\n")
  process.exit(0)
}

if (argv.includes("--version")) {
  process.stdout.write("1.1.85\n")
  process.exit(0)
}

let stdin = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  stdin += chunk
})
process.stdin.on("end", () => {
  record({ argv, stdin, stdinBytes: Buffer.byteLength(stdin, "utf8") })

  if (mode === "hang") {
    setInterval(() => {}, 1000)
    return
  }
  if (mode === "not-json") {
    process.stdout.write("this is not json\n")
    process.exit(0)
  }
  if (mode === "crash") {
    process.stderr.write("fatal: qoder exploded\n")
    process.exit(1)
  }

  const requested = argValue("--model") ?? "Auto"
  const actual = mode === "fallback" ? "auto" : requested.toLowerCase()
  const payload = {
    type: "result",
    subtype: "success",
    duration_ms: 42,
    duration_api_ms: 40,
    is_error: mode === "error",
    num_turns: 1,
    result: mode === "error" ? "Qoder run failed" : `ok: ${requested}`,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    total_credits: 0.25,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      [actual]: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
        credits: 0.25,
      },
    },
    permission_denials: [],
    fast_mode_state: "off",
    uuid: "fake-uuid",
    session_id: "fake-session",
  }
  process.stdout.write(JSON.stringify(payload) + "\n")
  process.exit(0)
})
