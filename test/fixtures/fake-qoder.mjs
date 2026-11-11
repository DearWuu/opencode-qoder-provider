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
 *  - FAKE_QODER_RECORD        path of the file that receives {argv, stdin, stdinBytes}
 *  - FAKE_QODER_PID_FILE      path of the file that receives the process pid
 *  - FAKE_QODER_MODE          ok | error | usage-auto | fallback | fallback-quoted |
 *                             hang | heartbeat | slow | partial | partial-no-result | partial-empty |
 *                             huge-out | huge-err | not-json | crash
 *  - FAKE_QODER_MODELS        newline separated model list for --list-models
 *  - FAKE_QODER_DISCOVERY_DELAY_MS  ms to wait before answering --list-models
 *  - FAKE_QODER_LIST_OUT_BYTES      extra stdout padding bytes for --list-models
 *  - FAKE_QODER_LIST_RECORD         append one JSON line {argv, cwd, nodeOptions} per --list-models call
 *  - FAKE_QODER_LIST_EXIT           exit with this code before answering --list-models
 *  - FAKE_QODER_PRICING             path of a catalog JSON for --list-models to JSON.parse
 *                                   (exercises the NODE_OPTIONS capture hook)
 *  - FAKE_QODER_DELAY_MS            ms `slow` waits before answering (default 5000)
 *  - FAKE_QODER_PARTIAL_DELAY_MS    ms between emitted stream-json lines
 *  - FAKE_QODER_RESULT_FILE         written only when `slow` gets to answer
 *  - FAKE_QODER_OUT_BYTES           stdout padding for `huge-out`
 *  - FAKE_QODER_ERR_BYTES           stderr padding for `huge-err`
 *  - FAKE_QODER_ZERO_USAGE          set: every token counter in the result is 0
 *  - FAKE_QODER_CONTEXT_RATIO       set usage.context_usage_ratio to this value
 *  - FAKE_QODER_RESULT_TEXT         override `result.result` (default "ok: <model>")
 *  - FAKE_QODER_STOP_REASON         override `result.stop_reason` (default "end_turn")
 *  - FAKE_QODER_USAGE_SPLIT         set: modelUsage has an all-zero `auto` entry
 *                                   plus the real usage under `fast` with credits
 *  - FAKE_QODER_EMPTY_STOP          "0": the empty text block gets no content_block_stop
 */
import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const mode = process.env.FAKE_QODER_MODE ?? "ok"

if (process.env.FAKE_QODER_PID_FILE) {
  writeFileSync(process.env.FAKE_QODER_PID_FILE, String(process.pid))
}

function argValue(flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

function record(payload) {
  const file = process.env.FAKE_QODER_RECORD
  if (!file) return
  writeFileSync(file, JSON.stringify(payload, null, 2))
}

/** Write exactly `bytes` padding to stdout (fd 1) or stderr (fd 2), honouring backpressure. */
async function fill(stream, bytes, char = "x") {
  const chunk = Buffer.alloc(Math.min(bytes, 64 * 1024), char)
  let remaining = bytes
  while (remaining > 0) {
    const slice = chunk.subarray(0, Math.min(chunk.length, remaining))
    remaining -= slice.length
    if (stream.write(slice)) continue
    await new Promise((resolve) => stream.once("drain", resolve))
  }
}

function spawnTrackedChild() {
  const file = process.env.FAKE_QODER_CHILD_PID_FILE
  if (!file) return
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  writeFileSync(file, String(child.pid))
}

function positiveNumberEnv(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return 0
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function resultPayload(requested) {
  const actual = ["usage-auto", "fallback", "fallback-quoted"].includes(mode) ? "auto" : requested.toLowerCase()
  const tokens = process.env.FAKE_QODER_ZERO_USAGE ? 0 : 10
  const outTokens = process.env.FAKE_QODER_ZERO_USAGE ? 0 : 5
  const ratio = positiveNumberEnv("FAKE_QODER_CONTEXT_RATIO")
  const usage = {
    input_tokens: tokens,
    output_tokens: outTokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
  if (ratio > 0) usage.context_usage_ratio = ratio
  // `split` mimics the real Auto accounting seen in the wild: an all-zero
  // `auto` entry first, the real usage under `fast` with credits.
  const modelUsage = process.env.FAKE_QODER_USAGE_SPLIT
    ? {
        auto: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, credits: 0 },
        fast: {
          inputTokens: tokens,
          outputTokens: outTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          contextWindow: 0,
          maxOutputTokens: 0,
          credits: 0.129,
        },
      }
    : {
        [actual]: {
          inputTokens: tokens,
          outputTokens: outTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          contextWindow: 0,
          maxOutputTokens: 0,
          credits: 0.25,
        },
      }
  return {
    type: "result",
    subtype: "success",
    duration_ms: 42,
    duration_api_ms: 40,
    is_error: mode === "error",
    num_turns: 1,
    result: mode === "error" ? "Qoder run failed" : (process.env.FAKE_QODER_RESULT_TEXT ?? `ok: ${requested}`),
    stop_reason: process.env.FAKE_QODER_STOP_REASON ?? "end_turn",
    total_cost_usd: 0,
    total_credits: 0.25,
    usage,
    modelUsage,
    permission_denials: [],
    fast_mode_state: "off",
    uuid: "fake-uuid",
    session_id: "fake-session",
  }
}

/**
 * `-o stream-json --include-partial-messages` transcript: system init, a
 * thinking block, a text block split into several deltas, the full assistant
 * message (which repeats the text), a non-JSON noise line and the result.
 */
function streamJsonLines(requested) {
  const text = `ok: ${requested}`
  const lines = [
    { type: "system", subtype: "init", qodercli_version: "1.1.85" },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, 4) } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(4) } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } },
  ]
  return lines
}

/**
 * Empty text block transcript: a `content_block_start` for a text block that
 * never emits a delta, an optional stop, then the result. `FAKE_QODER_RESULT_TEXT`
 * controls `result.result` (default ""), `FAKE_QODER_EMPTY_STOP=0` omits the
 * `content_block_stop` so the block is still open when the result arrives.
 */
function emptyTextLines(requested) {
  const lines = [
    { type: "system", subtype: "init", session_id: "fake-session" },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  ]
  if (process.env.FAKE_QODER_EMPTY_STOP !== "0") {
    lines.push({ type: "stream_event", event: { type: "content_block_stop", index: 0 } })
  }
  return lines
}

/** Resolve once everything queued on the stream has been flushed to the pipe. */
function flush(stream) {
  return new Promise((resolve) => stream.write("", resolve))
}

if (argv.includes("--list-models")) {
  if (process.env.FAKE_QODER_LIST_RECORD) {
    appendFileSync(
      process.env.FAKE_QODER_LIST_RECORD,
      `${JSON.stringify({ argv, cwd: process.cwd(), nodeOptions: process.env.NODE_OPTIONS })}\n`,
    )
  }
  if (process.env.FAKE_QODER_LIST_EXIT) {
    const code = Number(process.env.FAKE_QODER_LIST_EXIT)
    process.exit(Number.isFinite(code) && code !== 0 ? code : 1)
  }
  // 模拟真实 CLI：先 JSON.parse 解密后的目录明文，捕获 hook 才有机会截获。
  if (process.env.FAKE_QODER_PRICING) {
    try {
      JSON.parse(readFileSync(process.env.FAKE_QODER_PRICING, "utf8"))
    } catch {
      // 保持 CLI 行为：解析失败仍然输出模型表。
    }
  }
  const models = (process.env.FAKE_QODER_MODELS ?? "Auto\nFast\nQwen3.8-Max")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const list = ["MODEL", ...models].join("\n") + "\n"
  const padding = positiveNumberEnv("FAKE_QODER_LIST_OUT_BYTES")
  const delay = positiveNumberEnv("FAKE_QODER_DISCOVERY_DELAY_MS")
  const answer = async () => {
    process.stdout.write(list)
    if (padding > 0) {
      await fill(process.stdout, padding)
      await flush(process.stdout)
    }
    process.exit(0)
  }
  if (delay > 0) setTimeout(() => void answer(), delay)
  else void answer()
} else if (argv.includes("--version")) {
  process.stdout.write("1.1.85\n")
  process.exit(0)
} else {
  let stdin = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    stdin += chunk
  })
  process.stdin.on("end", () => {
    record({ argv, stdin, stdinBytes: Buffer.byteLength(stdin, "utf8") })

    if (mode === "hang") {
      spawnTrackedChild()
      setInterval(() => {}, 1000)
      return
    }
    if (mode === "heartbeat") {
      spawnTrackedChild()
      setInterval(() => process.stdout.write("."), 40)
      setInterval(() => process.stderr.write("."), 55)
      return
    }
    if (mode === "slow") {
      const delay = positiveNumberEnv("FAKE_QODER_DELAY_MS") || 5000
      setTimeout(() => {
        if (process.env.FAKE_QODER_RESULT_FILE) {
          writeFileSync(process.env.FAKE_QODER_RESULT_FILE, "answered")
        }
        process.stdout.write(JSON.stringify(resultPayload(argValue("--model") ?? "Auto")) + "\n")
        process.exit(0)
      }, delay)
      return
    }
    if (mode === "partial-empty") {
      void (async () => {
        for (const line of emptyTextLines(argValue("--model") ?? "Auto")) {
          process.stdout.write(`${JSON.stringify(line)}\n`)
        }
        process.stdout.write(`${JSON.stringify(resultPayload(argValue("--model") ?? "Auto"))}\n`)
        await flush(process.stdout)
        process.exit(0)
      })()
      return
    }
    if (mode === "partial" || mode === "partial-no-result") {
      void (async () => {
        const delay = positiveNumberEnv("FAKE_QODER_PARTIAL_DELAY_MS")
        const wait = async () => {
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        }
        for (const line of streamJsonLines(argValue("--model") ?? "Auto")) {
          process.stdout.write(`${JSON.stringify(line)}\n`)
          await wait()
        }
        process.stdout.write("this line is not json\n")
        await wait()
        if (mode === "partial") process.stdout.write(`${JSON.stringify(resultPayload(argValue("--model") ?? "Auto"))}\n`)
        await flush(process.stdout)
        process.exit(0)
      })()
      return
    }
    if (mode === "huge-err") {
      void (async () => {
        await fill(process.stderr, positiveNumberEnv("FAKE_QODER_ERR_BYTES"), "e")
        await flush(process.stderr)
        finishQuietly()
      })()
      return
    }
    if (mode === "huge-out") {
      void (async () => {
        await fill(process.stdout, positiveNumberEnv("FAKE_QODER_OUT_BYTES"))
        await flush(process.stdout)
        process.exit(0)
      })()
      return
    }
    finishQuietly()
  })
}

/** Ordinary (non-huge) result path. */
function finishQuietly() {
  if (mode === "not-json") {
    process.stdout.write("this is not json\n")
    process.exit(0)
  }
  if (mode === "crash") {
    process.stderr.write("fatal: qoder exploded\n")
    process.exit(1)
  }

  const requested = argValue("--model") ?? "Auto"
  if (mode === "fallback") {
    process.stderr.write("Model efficient is not available, falling back to auto instead\n")
  } else if (mode === "fallback-quoted") {
    process.stderr.write('Model "efficient" is not available, using "auto" instead\n')
  }
  process.stdout.write(JSON.stringify(resultPayload(requested)) + "\n")
  process.exit(0)
}
