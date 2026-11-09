/**
 * Qoder provider runtime for OpenCode.
 *
 * OpenCode loads this module through `aisdk:file://<absolute path>` and calls the
 * `createQoder(options)` factory. The returned object exposes `languageModel(modelID)`
 * which returns an AI SDK LanguageModelV3 that drives the Qoder CLI.
 */
import { createLanguageModel } from "./src/provider.mjs"
import { resolveOptions } from "./src/options.mjs"

export { createQoder, createLanguageModel } from "./src/provider.mjs"
export {
  ALLOWED_PERMISSION_MODES,
  CLI_STDIN_LIMIT_BYTES,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_BYTES,
  PROVIDER_ID,
  PROVIDER_NAME,
  defaultLogFile,
  resolveOptions,
} from "./src/options.mjs"

/**
 * Compatibility export for OpenCode's native provider protocol
 * ("Provider package <x> does not export model(modelID, settings)").
 * OpenCode itself resolves this module through the `aisdk:` package path; this
 * keeps the module usable through the plain provider protocol as well.
 */
export function model(modelID, settings = {}) {
  return createLanguageModel(modelID, resolveOptions(settings))
}
