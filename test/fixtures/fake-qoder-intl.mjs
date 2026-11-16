#!/usr/bin/env node
/**
 * 海外变体（`qoder`）专用的 fake CLI：默认 16 模型集，其余行为复用 fake-qoder.mjs。
 *
 * 上游：test/plugin.test.ts 等把本文件当作海外变体的 CLI 路径注入。
 * 下游：fake-qoder.mjs（动态 import，先设好默认模型集再复用同一套行为）。
 *
 * `FAKE_QODER_MODELS` 显式设置时不覆盖：测试可以精确控制模型集。
 */
process.env.FAKE_QODER_MODELS ??= process.env.FAKE_QODER_INTL_MODELS ?? [
  "Auto",
  "Ultimate",
  "Fast",
  "Efficient",
  "Sonus",
  "Cantus",
  "Qwen4-Max",
  "Qwen3.8-Max",
  "Qwen3.8-Flash",
  "Kimi-K3.1-Pro",
  "Kimi-K2.8-Preview",
  "GLM-5.3",
  "GLM-5.3-Flash",
  "DeepSeek-V4-Pro",
  "DeepSeek-Flash",
  "MiniMax-M3.1-Flash",
].join("\n")

await import("./fake-qoder.mjs")
