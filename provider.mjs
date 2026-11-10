/**
 * 文件职责：provider runtime 入口，导出 `createQoder(options)`、CLI 选项常量与兼容的 `model()`。
 * 上游：index.ts 以 `aisdk:` 包路径交给 OpenCode，OpenCode 原生 provider 协议调用 `model()`。
 * 下游：src/provider、src/options。
 */
import { createLanguageModel } from "./src/provider.mjs"
import { resolveOptions } from "./src/options.mjs"

export { createQoder, createLanguageModel } from "./src/provider.mjs"
export {
  ALLOWED_PERMISSION_MODES,
  CLI_STDIN_LIMIT_BYTES,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_BYTES,
  PROVIDER_ID,
  PROVIDER_NAME,
  defaultLogFile,
  resolveOptions,
} from "./src/options.mjs"

/**
 * 面向 OpenCode 原生 provider 协议的兼容导出
 * （"Provider package <x> does not export model(modelID, settings)"）。
 * OpenCode 正常走 `aisdk:` 包路径解析本模块；这个导出让模块同时能被纯 provider 协议使用。
 */
export function model(modelID, settings = {}) {
  return createLanguageModel(modelID, resolveOptions(settings))
}
