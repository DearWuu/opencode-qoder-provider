# opencode-qoder-provider

把 OpenCode 的模型调用接到 **Qoder CLI**（`qoderclicn`）上，按 Qoder 的 **Credits** 计费。

- provider 显示名：`Qoder (Credits)`；OpenCode provider ID：`qoder`
- 模型目录来自 `qoderclicn --list-models`：OpenCode ID 用 lowercase kebab-case（`qoder/auto`、`qoder/qwen3-8-max`），modelID 保留 Qoder 原值（`Auto`、`Qwen3.8-Max`）
- runtime 直接 spawn 已登录的 Qoder CLI，**不启动 HTTP 代理**，不改全局配置，不动现有 provider/model 的默认选择
- 每条回答附带 Credits、Qoder session id，并写入无 prompt 的 JSONL 调用日志


## 安装

把源码直接克隆到 OpenCode 的本地插件目录，再安装依赖（含 `@opencode/plugin` 与 Qoder CLI）：

```bash
git clone https://github.com/DearWuu/opencode-qoder-provider.git \
  ~/.config/opencode/plugins/opencode-qoder-provider
cd ~/.config/opencode/plugins/opencode-qoder-provider
npm install
```

`package.json` 的 `exports` 声明插件的三个部分：`"./server": "./index.ts"`（服务端）、`"./tui": "./tui.ts"`（TUI）、`"./rpc": "./rpc.ts"`（RPC 契约）。OpenCode 会按需加载：服务端负责 provider 与模型目录，TUI 负责 `/qoder` 的 dialog，RPC 契约由两端共享。

## 登录 Qoder CLI

插件**不会**替你跑交互式登录，也**不会**伪造登录成功。请在终端里自己完成：

```bash
qoderclicn login
# 若 CLI 装在插件目录里：
~/.config/opencode/plugins/opencode-qoder-provider/node_modules/.bin/qoderclicn login
```

登录后回到 OpenCode 执行 `/qoder refresh` 重新发现模型，`/qoder status` 确认状态。

未登录或 CLI 缺失时，插件仍会注册 `Auto`、`Fast` 两个占位模型，调用时给出可执行的修复建议，不会让模型列表变成空的。

## 在 /models 里选模型

```
/models
```

会看到 provider `Qoder (Credits)` 下的模型，ID 形如：

| OpenCode ID | Qoder modelID |
| --- | --- |
| `qoder/auto` | `Auto` |
| `qoder/fast` | `Fast` |
| `qoder/qwen3-8-max` | `Qwen3.8-Max` |
| `qoder/glm-5-3` | `GLM-5.3` |
| `qoder/minimax-m3-1-flash` | `MiniMax-M3.1-Flash` |

模型清单随账号变化，用 `/qoder refresh` 刷新。

> **`/models` 里搜 provider 名搜不到**：上游 2.2.6 的原生模型选择器只按**模型标题/分类（title/category）**过滤搜索文本，不搜 provider 名，输入 `qoder` 会过滤掉全部结果。workaround：直接**清空搜索词**浏览 `Qoder (Credits)` 分组，或搜模型名（如 `Fast`、`Auto`、`Qwen3.8`）；派 Superagent 时 picker 里可以直接搜 `qoder` 选 `qoder/*` 模型。

## 在 Subagent 里用 qoder/auto

在 `opencode.jsonc` 里定义一个使用 Qoder 的 agent：

```jsonc
{
  "agent": {
    "qoder-worker": {
      "description": "把子任务交给 Qoder 执行（按 Credits 计费）",
      "mode": "all",
      "model": "qoder/auto",
      "prompt": "你是子代理，完成分配给你的任务后用一段话总结结果。"
    }
  }
}
```

之后让主 agent 用 `subagent` 工具派活，或直接在会话里选 `qoder/auto`：

```
用 qoder-worker 子代理在 /tmp/work 下生成 marker.txt
```

Qoder 会以 `--cwd <当前工作目录>` 启动，用它自己的原生 agent 工具在那个目录里读写文件；OpenCode 侧的工具不会传给 Qoder。

## Herdr 可选编排边界

Herdr 不是安装或使用本插件的前置依赖。需要多子代理编排时，可以让 Herdr 把任务分派给上述使用 `qoder/*` 模型的 OpenCode Subagent；任务拆解、调度、并发、重试与验收由 Herdr 负责，本插件仍只负责模型目录、Qoder CLI 调用和 `/qoder` 本地状态命令。

本插件不实现 Herdr，也不重写 OpenCode 已有的通用 agent、provider、模型、会话或命令管理；不使用 Herdr 时，OpenCode 原生 `/models` 与 Subagent 流程可以独立使用。

## /qoder 命令

| 命令 | 作用 |
| --- | --- |
| `/qoder` 或 `/qoder status` | 本地状态：CLI 路径与版本、认证情况、模型数、权限模式、超时、日志文件、最近一次调用与累计 Credits。**不调用模型** |
| `/qoder refresh` | 重新执行 `--list-models` 并 `provider.reload()`，随后刷新 TUI 的模型列表 |
| `/qoder models` | 列出可选的 `qoder/*` ID 与对应原始模型名 |
| `/qoder login` | 打印终端登录指引（不执行登录、不伪造成功） |

**TUI 里**：`/qoder` 由 TUI 插件的 keymap 接管，结果直接弹在原生 dialog（标题 `Qoder`）里；命令失败时弹 error toast。`/qoder refresh` 之后会 `invalidate` + `sync` 当前 location 的模型列表，模型选择器立刻拿到新目录。

**通过 API 或非 TUI 客户端**：`/qoder` 由服务端命令处理，结果写进 session inbox（synthetic 消息），不唤醒会话。

两条路径共用同一份实现：服务端 `executeQoderCommand(text)` 同时被 server command 与 `qoder` RPC 调用，文案统一放在 `src/command.mjs`，所以 dialog 与 API 的回答不会出现两套逻辑。两者都不产生模型调用。

> **实现细节**：server 端写 inbox 用 `ctx.session.synthetic({..., resume: false })`。
> `resume: false` 很关键——`session.synthetic()` 默认会 **wake** 会话，被唤醒的会话会把这条
> synthetic 当作输入再跑一轮模型（实测每次 `/qoder status` 都会多出一次 Qoder 调用和一条
> assistant 轮次）。改用 `resume: false` 后命令只记录消息、不唤醒会话，**实测 0 次额外模型调用**。
> 代价：文本先停在 session inbox，会在下一次 wake 时并入会话上下文，而不是立刻出现在消息流里。

## RPC 契约

服务端注册 `qoder` 这份 RPC 契约，TUI 用它拿结果，外部客户端也能直接调用（只读本地状态，不调用模型）：

```bash
curl -u "opencode:<口令>" -X POST \
  "http://127.0.0.1:4397/api/rpc/qoder/execute?location[directory]=$PWD" \
  -H "content-type: application/json" \
  -d '{"input":{"text":"status"}}'
```

返回 `{"output":{"text":"Qoder provider status ..."}}`。`text` 与 `/qoder` 命令的入参同义：`status`（默认）、`refresh`、`models`、`login`。

## 配置项

插件选项来自 OpenCode 配置里 `plugins[].options` 对象，也可以用环境变量覆盖：

| 选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `cliPath` | `QODER_CLI_PATH` | 插件自带的 `node_modules/@qodercn-ai/qoderclicn/bundle/qoderclicn.js`，其次是 `PATH` 里的 `qoderclicn` | Qoder CLI 可执行文件 |
| `permissionMode` | `QODER_PERMISSION_MODE` | `default` | 透传给 `--permission-mode`。可选：`default`、`accept_edits`、`bypass_permissions`、`dont_ask`、`auto`。默认是安全值 `default`（写文件/执行命令逐项确认）；`accept_edits`、`auto`、`dont_ask`、`bypass_permissions` 都会放宽 Qoder CLI 的确认门槛，属于**显式启用、风险自担**，非法取值会直接报错而不是退回默认值 |
| `timeoutMs` | `QODER_TIMEOUT_MS` | `1800000`（30 分钟） | 单次调用超时，超时后终止整个进程树；非法值直接报错 |
| `contextLimit` | — | `200000` | 推导近似 token 数用的上下文窗口（见「限制与已知问题」的近似说明），非法值直接报错 |
| `logFile` | `QODER_LOG_FILE` | `${XDG_STATE_HOME:-~/.local/state}/opencode/qoder-provider/calls.jsonl` | JSONL 调用日志（目录 0700、文件 0600） |
| `additionalDirs` | — | `[]` | 字符串数组，逐个映射为 `--add-dir <dir>`，把这些目录**扩大**进 Qoder 的工作区范围（扩权操作，路径写错不会报错只会扩错地方） |
| `cliTools` | — | 不传（CLI 用自身默认） | 字符串数组映射为 `--tools <t>…`；传 `""`（空串）**禁用** Qoder CLI 全部内置工具；`["default"]` 恢复全部。传其他类型或数组里含空字符串会直接报错 |
| — | — | `ctx.location.directory` | CLI 的 `--cwd`，取当前 OpenCode 工作目录 |

示例（`opencode.jsonc`，OpenCode V2 的 `plugins` 数组写法；旧的 `plugin` 键已废弃）：

```jsonc
{
  "plugins": [
    {
      "package": "opencode-qoder-provider",
      "options": {
        "cliPath": "/usr/local/bin/qoderclicn",
        // 示例为放宽确认门槛的显式授权用法；不传时保持安全默认 `default`，写文件/执行命令逐项确认
        "permissionMode": "accept_edits",
        "timeoutMs": 1800000
      }
    }
  ]
}
```

## 调用日志

每次调用写一行 JSON（**不含 prompt、不含回答、不含任何凭证**）。字段包括 `ts`、`provider`、`model`、`actualModel`、`modelFallback`、`usageModelKey`、`usageModelKeys`、`credits`、`durationMs`、`isError`、`exitCode` 与 `sessionId`，具体值来自当次 CLI 调用。

同样的数据也会放进 AI SDK 的 `providerMetadata.qoder`，方便上层读取 Credits 与 Qoder session id。仓库不包含真实调用日志。

## 限制与已知问题

- **stdin 体积上限**：`qoderclicn` 1.1.85 会把 stdin 截断到 **8388608 字节**（截断时只打印一行 warning）。本插件在 **7340032 字节（7 MiB）** 就直接报错 `PromptTooLargeError`，避免静默截断导致回答莫名其妙地少一截。
- **上下文 token 展示值是近似推导**：Qoder CLI 的 `usage`/`modelUsage` token 计数恒为 0（OpenCode 因此显示不出 `tokens / % used` 指示）。插件在 token 计数缺失或为 0 且 `usage.context_usage_ratio` 有效（0<r≤1）时，按 `round(ratio × contextLimit)` 推导 `inputTokens.total`；真实非零 token 永远优先、不被覆盖。`contextLimit` 默认 200000、可配置（同时写入模型元数据的 `limit.context`，**不是 Qoder 实测上限**）；`providerMetadata.qoder` 记录 `contextUsageRatio` 与 `approximatedContextTokens` 标志标明该值为估算。
- **只支持文本**：capabilities 为 `{tools: false, input: ["text"], output: ["text"]}`。prompt 里出现图片/文件会**明确报错**（`UnsupportedMediaError`），不会静默丢弃。
- **不做 OpenCode 工具桥接**：OpenCode 的 tool schema 不会传给 Qoder，Qoder 用自己的原生 agent 工具在 `--cwd` 目录工作；因此 `tools` 标为 `false`。
- **prompt 被拍平成纯文本**：system/user/assistant/tool 会被序列化成带 `[system]`/`[user]`/`[assistant]`/`[tool]` 前缀的文本（工具调用序列化为 JSON），角色语义会有损失。
- **不传 `--input-format`**：CLI 1.1.85 校验 `--input-format=stream-json requires output-format=stream-json`，所以 prompt 只能以纯文本写 stdin。
- **流式**：`doStream` 用 `-o stream-json --include-partial-messages`（隐藏参数，1.1.85 bundle 实证）驱动 CLI，把 `content_block_delta` 的 `text_delta` 实时映射为 AI SDK `text-delta`，`thinking_delta` 映射为 `reasoning-delta`（不混入正文）；最终 `assistant` 事件不会重复输出已流式的文本；CLI 未产生任何 partial 事件时回退为整段输出。`doGenerate` 保持单文档 `-o json`。流中缺少 `result` 事件会明确失败。
- **模型回落判定**：只有 CLI stderr 明确输出 `Model ... falling back to ...` 或 `Model ... using ... instead` 才认定为回落。`result.modelUsage` 的 key 只作为 `usageModelKey` / `usageModelKeys` 记录，不参与回落判定，也不冒充 `actualModel`；没有明确 stderr 时，`actualModel` 使用请求模型，DeepSeek-Flash 或 Fast 搭配 `modelUsage.auto` 不会产生警告或失败。
- **明确回落处理**：`execute` 记录 Credits、session、错误状态、exitCode 与耗时后抛出 `ModelFallbackError`。`doGenerate` 拒绝该调用，`doStream` 发出 error part，均不返回成功结果、不自动重试。
- **会话标题会额外调一次模型**：OpenCode 用会话模型生成会话标题，这是 OpenCode 自带行为、与插件无关，会多消耗一次 Credits。可在 OpenCode 配置里设 `small_model` 指向便宜的模型来避免。
- **CLI 缺失/未登录**：调用会失败并给出安装或登录指引；占位模型仍可选择。
- 插件不修改任何全局默认模型，也不写入 Qoder 之外的目录。
- **`/qoder` 同名命令有两处**：TUI 的 slash（keymap）与服务端命令。TUI 里 keymap 先接管，结果进 dialog、session inbox 不新增消息；非 TUI 客户端走服务端命令，结果进 session inbox。两条路径的回答内容一致。
- **OpenCode 的 HTTP API 始终要求 basic auth**：`opencode serve` 会生成服务端口令（`OPENCODE_PASSWORD` 可指定），远程调用需要 `Authorization: Basic base64(opencode:<password>)`。这与本插件无关。

## 安全

- **不含凭证**：插件代码与仓库不包含任何密钥、token、凭据或真实调用日志；密钥只可能存在于本机的 Qoder CLI 登录态里，插件不读取、不转发、不落盘。
- **日志脱敏**：`calls.jsonl` 只记录模型名、Credits/用量元数据与 session 标识，**不含 prompt、回答与任何凭证**；日志目录按 0700、文件按 0600 创建，对已存在的文件 best-effort 收紧权限。
- **本地运行边界**：每次调用 spawn 本机已登录的 `qoderclicn` 子进程（本地进程，不外发请求、不启 HTTP 代理），工作区限定在 `--cwd`（当前 OpenCode 目录）；`additionalDirs`（`--add-dir`）与 `cliTools`（`--tools`）会改变这个边界——前者**扩大** Qoder 可写目录、属扩权操作，后者可用 `--tools ""` 完全禁用 Qoder 内置工具、收紧能力。超时/取消/中止都会终止整个子进程树（Windows 走 `taskkill /t /f`）。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.ts` | OpenCode 服务端插件。`Plugin.define` + `ctx.provider.transform` 注册 provider 与模型，`ctx.command.transform` 注册 `/qoder`，`ctx.aisdk.hook("sdk")` 把 provider runtime 交给 OpenCode，`ctx.rpc.register` 注册 `qoder` RPC |
| `tui.ts` | OpenCode TUI 插件。注册 `/qoder` slash 命令，调用 `qoder` RPC 拿结果，用原生 dialog 显示 |
| `rpc.ts` | RPC 契约：`qoder` id、`execute` 方法（`{text}` → `{text}`），server 与 TUI 共用 |
| `provider.mjs` | provider runtime。导出 `createQoder(options)`，返回带 `languageModel(modelID)` 的 provider（AI SDK **LanguageModelV3**） |
| `src/options.mjs` | 选项与默认值解析（CLI 路径、权限模式、超时、日志位置） |
| `src/models.mjs` | Qoder 模型名 ↔ OpenCode 模型 ID 映射、目录解析 |
| `src/prompt.mjs` | prompt 序列化（system/user/assistant/tool）与字节上限检查 |
| `src/cli.mjs` | spawn Qoder CLI、stdin 写入、进程树终止、超时 |
| `src/result.mjs` | CLI 结果 → AI SDK V3 结果、Credits 提取、回落检测 |
| `src/logger.mjs` | JSONL 调用日志（无 prompt、无凭证） |
| `src/catalog.mjs` | `--list-models` / `--version` 调用 |
| `src/command.mjs` | `/qoder` 的子命令解析与状态/目录/登录文案（server 与 TUI 共用同一份） |

OpenCode 通过 `aisdk:file://<绝对路径>/provider.mjs` 解析 provider；该模块导出 `createQoder(options)`，OpenCode 随后调用 `sdk.languageModel(modelID)`。

## 开发与测试

```bash
npm ci
npm run test:node # Node 24 原生运行 TypeScript 测试
npm run check     # tsc --noEmit
```

另有可选的 `npm test`（Bun）与 `npm run check:catalog`。后者会用真实 Qoder CLI 读取一次 `--list-models`，只用于本地人工检查；自动化测试与 CI 不运行它。

测试用 `test/fixtures/fake-qoder.mjs` 假 CLI，**不消耗 Credits、不联网、不需要登录**。覆盖：模型 ID 与冲突、prompt 多角色序列化与媒体报错、stdin 纯文本（断言参数里没有 `--input-format`）、doGenerate/doStream 的 V3 事件、`is_error`、明确回落拒绝与误报防护、Credits metadata 与日志脱敏、abort 与超时。

另外覆盖 TUI 与 RPC：RPC 契约的形状、`/qoder` slash 注册、RPC 调用成功走 dialog、失败走 error toast、`refresh` 之后刷新模型列表、server command 与 RPC 返回同一段文本、插件卸载时注销 RPC 注册。

## 许可

MIT
