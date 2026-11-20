# opencode-qoder-provider

把 OpenCode 的模型调用接到 **Qoder CLI** 上，按 Qoder 的 **Credits** 计费。插件同时提供两个 provider：

| provider ID | 显示名 | CLI | 登录态 |
| --- | --- | --- | --- |
| `qodercn` | `QoderCN (Credits)` | `qoderclicn`（随包安装，优先） | `~/.qoder-cn` |
| `qoder` | `Qoder (Credits)` | `qodercli`（海外版，需自行安装） | `~/.qoder` |

- 模型目录来自对应 CLI 的 `--list-models`：OpenCode ID 用 lowercase kebab-case，引用形式是 `{providerID}/{modelID}`（`qodercn/auto`、`qoder/qwen3-8-max`），modelID 保留 Qoder 原值（`Auto`、`Qwen3.8-Max`）
- runtime 直接 spawn 已登录的 Qoder CLI，**不启动 HTTP 代理**，不改全局配置，不动现有 provider/model 的默认选择
- 每条回答附带 Credits、Qoder session id，并写入无 prompt 的 JSONL 调用日志（按变体分账）
- 侧边栏分两段展示两个变体（插件排在 `plugins` 数组最后时沉底）：本地 Today、官方 `/usage` 真实套餐额度（同屏多额度逐行带标签，含共享资源包）、每模型实时积分倍率与低峰折扣倒计时；额度与倍率读取都不发送模型 prompt
- 倍率来自 `--list-models` 解密明文的捕获（零模型调用），窗口按 `HH:mm` + IANA 时区每日重复（CN 是 `Asia/Shanghai`，海外是 `Asia/Singapore`），快照缓存 10 分钟，抓取失败时保留上一份数据

> **0.3.0 破坏性变更**：原 `qoder` provider 现在是**海外版**；原 CN 版改用 `qodercn` provider ID。已有配置里的 `qoder/auto` 等引用要迁移为 `qodercn/auto`（CN）或 `qoder/auto`（海外）。详见「破坏性变更」一节。

## 破坏性变更（0.3.0）

| 变更 | 之前 | 现在 | 迁移 |
| --- | --- | --- | --- |
| CN provider ID | `qoder` | `qodercn` | `qoder/auto` → `qodercn/auto`（agent、模型选择、脚本） |
| CN provider 显示名 | `Qoder (Credits)` | `QoderCN (Credits)` | 仅影响界面显示 |
| `qoder` provider | CN 版 | **海外版** | 想要 CN 就改用 `qodercn/*` |
| 调用日志 `provider` 字段 | `qoder`（CN） | `qodercn` / `qoder` | 新增 `variant` 字段；旧记录按 CN 归账，不会丢 |
| `/qoder` 子命令 | `/qoder models`（CN） | `/qoder models`（仍是 CN）+ `/qoder intl models`（海外） | 不带变体 token 的调用行为不变 |
| RPC 入参 | 无变体字段 | 可选 `variant`（`qodercn` / `qoder`） | 缺省 `qodercn`，旧客户端不受影响 |

## 0.3.1 变更

- **多额度显示**：侧边栏按官方 `/usage` 同屏数值额度逐行带标签展示（个人/共享资源包/加量包），RPC `quota` 新增可选 `quotas` 数组，主额度不再代表全部额度。
- **图片输入**：两个变体的 prompt 里的 image part 与 `image/*` file part 经 CLI `--attachment` 传入，临时文件在调用结束后立即清理；非图片文件明确报 `UnsupportedMediaError`。
- **工具桥接（Agent / 插件工具）**：宿主的 function 工具清单经 `--append-system-prompt` 注入文本协议，模型用 `<tool_call>` 信封回复，provider 解析为 AI SDK `tool-call`（流式对应 `tool-input-*`）；桥接期间 CLI 内置工具被临时禁用。两个变体与 `doGenerate`/`doStream` 行为一致，Subagent 与插件工具因此可用；`toolBridge: false` 可退回旧行为。
- **pricing 冷启动重试**：倍率提取遇到 CLI 冷启动（自举、令牌刷新）拿不到目录时有界重试（最多 3 次、间隔 1.5 秒、总预算 60 秒），仍失败才降级为 `null`。
- **面板截断加固**：侧边栏逐行按显示宽度截断，窄侧栏下数值与长文案不再溢出；宽度口径统一走 `src/text.mjs`。
- **沉底走配置顺序**：面板不再挂固定 footer，沉底由 `plugins` 数组顺序决定——把本插件排在最后即可。

随包 CN CLI 升级到 `@qodercn-ai/qoderclicn` 1.1.90。

## 安装

把源码直接克隆到 OpenCode 的本地插件目录，再安装依赖（含 `@opencode/plugin`、CN 版 Qoder CLI 与跨平台 `node-pty`）：

```bash
git clone https://github.com/DearWuu/opencode-qoder-provider.git \
  ~/.config/opencode/plugins/opencode-qoder-provider
cd ~/.config/opencode/plugins/opencode-qoder-provider
npm install
```

CN 版 CLI（`qoderclicn`）随依赖安装；海外版 CLI（`qodercli`）**不随包分发**，需要自行全局安装并保证在 `PATH` 上：

```bash
npm i -g @qoder-ai/qodercli   # 提供 qodercli（以及 qoder 别名）
```

没装海外 CLI 时，`qoder` provider 仍会注册（占位模型 Auto/Fast），调用会给出可执行的修复建议。

`package.json` 的 `exports` 声明插件的三个部分：`"./server": "./index.ts"`（服务端）、`"./tui": "./tui.ts"`（TUI）、`"./rpc": "./rpc.ts"`（RPC 契约）。OpenCode 会按需加载：服务端负责 provider 与模型目录，TUI 负责 `/qoder` 的 dialog，RPC 契约由两端共享。

## 登录 Qoder CLI

插件**不会**替你跑交互式登录，也**不会**伪造登录成功。请在终端里自己完成（两个变体各登录一次）：

```bash
qoderclicn login   # CN 变体（~/.qoder-cn）
qodercli login     # 海外变体（~/.qoder）
# 若 CN CLI 装在插件目录里：
~/.config/opencode/plugins/opencode-qoder-provider/node_modules/.bin/qoderclicn login
```

登录后回到 OpenCode 执行 `/qoder refresh` 与 `/qoder intl refresh` 重新发现模型，`/qoder status` 与 `/qoder intl status` 确认状态。

未登录或 CLI 缺失时，插件仍会注册 `Auto`、`Fast` 两个占位模型，调用时给出可执行的修复建议，不会让模型列表变成空的。

## 在 /models 里选模型

```
/models
```

会看到两个 provider 分组，ID 形如：

| OpenCode ID | Qoder modelID | 变体 |
| --- | --- | --- |
| `qodercn/auto` | `Auto` | CN |
| `qodercn/qwen3-8-max` | `Qwen3.8-Max` | CN |
| `qoder/auto` | `Auto` | 海外 |
| `qoder/ultimate` | `Ultimate` | 海外 |
| `qoder/qwen3-8-max` | `Qwen3.8-Max` | 海外 |

模型清单随账号变化，用 `/qoder refresh`（CN）或 `/qoder intl refresh`（海外）刷新对应变体。

> **OpenCode 会话内 prompt 级 model 覆盖可能被静默忽略**：向已有会话的 prompt body 里携带 `model` 字段不会报错，但 OpenCode 2.2.6 会按**会话模型**执行并计费，请求里的模型覆盖被丢弃（实测：prompt 级覆盖返回 `delivery:"steer"` 并按会话模型计费）。请用 `/models` 或会话模型设置选择 `qodercn/*` / `qoder/*` 模型，不要依赖 prompt 级覆盖。

> **`/models` 里搜 provider 名搜不到**：上游 2.2.6 的原生模型选择器只按**模型标题/分类（title/category）**过滤搜索文本，不搜 provider 名，输入 `qoder` 会过滤掉全部结果。workaround：直接**清空搜索词**浏览 `QoderCN (Credits)` / `Qoder (Credits)` 分组，或搜模型名（如 `Fast`、`Auto`、`Qwen3.8`）；派 Superagent 时 picker 里可以直接搜 `qoder` 选 `qoder/*` 模型。

## 在 Subagent 里用 qodercn/auto

在 `opencode.jsonc` 里定义一个使用 Qoder 的 agent：

```jsonc
{
  "agent": {
    "qoder-worker": {
      "description": "把子任务交给 Qoder 执行（按 Credits 计费）",
      "mode": "all",
      "model": "qodercn/auto",
      "prompt": "你是子代理，完成分配给你的任务后用一段话总结结果。"
    }
  }
}
```

之后让主 agent 用 `subagent` 工具派活，或直接在会话里选 `qodercn/auto`（海外账号用 `qoder/auto`）：

```
用 qoder-worker 子代理在 /tmp/work 下生成 marker.txt
```

Qoder 会以 `--cwd <当前工作目录>` 启动，用它自己的原生 agent 工具在那个目录里读写文件；OpenCode 侧的工具不会传给 Qoder。

## Herdr 可选编排边界

Herdr 不是安装或使用本插件的前置依赖。需要多子代理编排时，可以让 Herdr 把任务分派给上述使用 `qodercn/*` / `qoder/*` 模型的 OpenCode Subagent；任务拆解、调度、并发、重试与验收由 Herdr 负责，本插件仍只负责模型目录、Qoder CLI 调用和 `/qoder` 本地状态命令。

本插件不实现 Herdr，也不重写 OpenCode 已有的通用 agent、provider、模型、会话或命令管理；不使用 Herdr 时，OpenCode 原生 `/models` 与 Subagent 流程可以独立使用。

## /qoder 命令

命令格式是 `/qoder [变体] <子命令>`，变体可省略，缺省是 CN：

| 变体 token | provider | 说明 |
| --- | --- | --- |
| `cn`、`qodercn` | `qodercn`（`QoderCN (Credits)`） | 缺省变体 |
| `intl`、`qoder`、`global` | `qoder`（`Qoder (Credits)`） | 海外版 |

| 命令 | 作用 |
| --- | --- |
| `/qoder` 或 `/qoder status` | 该变体的 CLI 路径与版本、认证情况、模型数、权限模式、双超时、日志文件、最近调用、官方 `/usage` 额度来源/结果/错误，以及 Pricing 摘要（低峰进行中、倒计时进入低峰或当前无低峰折扣；无倍率快照或快照无有效模型时整行省略）。**不调用模型** |
| `/qoder refresh` | 重新执行该变体的 `--list-models`，成功后把新目录同步给所有已加载 location（各自 `provider.reload()`），主动刷新官方 `/usage` 额度，并刷新每模型倍率快照；随后刷新当前 location 的 TUI 模型列表 |
| `/qoder models` | 列出该变体可选的 `{providerID}/*` ID 与对应原始模型名；有倍率快照时在行尾追加当前倍率与促销态 |
| `/qoder login` | 打印该变体 CLI 的终端登录指引（不执行登录、不伪造成功） |

**TUI 里**：`/qoder` 由 TUI 插件的 keymap 接管，结果直接弹在原生 dialog（标题 `Qoder`）里；RPC 命令失败时弹 error toast。官方额度不可用只在面板和 status 中显示 `unavailable` 及原因，不弹 toast。`/qoder refresh` 之后会 `invalidate` + `sync` 当前 location 的模型列表，模型选择器立刻拿到新目录。

**目录同步**：任一 location 执行 `/qoder refresh`（或 `/qoder intl refresh`）成功后，同一服务进程内所有已加载 location 的**该变体**模型目录一起更新；其他 location 不需要再次执行发现，两个变体的目录互不覆盖。发现失败时各 location 保留原目录，不广播。没有其他 location 时行为与单 location 一致。

**通过 API 或非 TUI 客户端**：`/qoder` 由服务端命令处理，结果写进 session inbox（synthetic 消息），不唤醒会话。

两条路径共用同一份实现：服务端 `executeQoderCommand(text)` 同时被 server command 与 `qoder` RPC 调用，文案统一放在 `src/command.mjs`，所以 dialog 与 API 的回答不会出现两套逻辑。两者都不产生模型调用。

> **实现细节**：server 端写 inbox 用 `ctx.session.synthetic({..., resume: false })`。
> `resume: false` 很关键——`session.synthetic()` 默认会 **wake** 会话，被唤醒的会话会把这条
> synthetic 当作输入再跑一轮模型（实测每次 `/qoder status` 都会多出一次 Qoder 调用和一条
> assistant 轮次）。改用 `resume: false` 后命令只记录消息、不唤醒会话，**实测 0 次额外模型调用**。
> 代价：文本先停在 session inbox，会在下一次 wake 时并入会话上下文，而不是立刻出现在消息流里。

## RPC 契约

服务端注册 `qoder` 这份 RPC 契约，TUI 与外部客户端均可调用；任何 RPC 方法都不会产生模型调用：

```bash
curl -u "opencode:<口令>" -X POST \
  "http://127.0.0.1:4397/api/rpc/qoder/execute?location[directory]=$PWD" \
  -H "content-type: application/json" \
  -d '{"input":{"text":"status"}}'
```

返回 `{"output":{"text":"QoderCN (Credits) provider status ..."}}`。`text` 与 `/qoder` 命令的入参同义：`status`（默认）、`refresh`、`models`、`login`；前面可加变体 token（`cn` / `intl`）。`refresh` 由请求指定的 location 执行发现，成功后同步所有已加载 location 的该变体模型目录。

四个方法都接受可选的 `variant` 字段（枚举 `qodercn` / `qoder`，缺省 `qodercn`）：`execute` 的文本里写了变体 token 时以文本为准，否则用 `variant`；`stats` / `quota` / `pricing` 直接按 `variant` 取对应变体的数据。

`stats` 方法返回：`provider`（变体 ID）、`models`、`authenticated`、`permissionMode`、`cliVersion`、`totalCalls`、`totalCredits`、`todayCalls`、`todayCredits`、`lastModel`、`lastCredits`、`lastAt`、`lastError`。它只读 `calls.jsonl` 与模型目录，不启动配额 PTY、不调用模型、不联网。统计按变体分账：两个变体的调用与 Credits 互不混算；0.2.x 之前的旧记录只有 `provider` 字段（当时只有 CN 变体），归到 CN。所有字段恒存在、恒非 null：未知字符串为 `""`、未知数值为 `0`（`lastAt === ""` 即"还没有调用"）。

`quota` 方法接受可选 `{ "refresh": boolean }`，返回 `available`、`source`、`used`、`total`、`remaining`、`percentage`、`expiresAt`、`fetchedAt`、`cached`、`error`，以及可选 `quotas` 数组（同屏全部数值额度，每条 `{ label, name, used, total, remaining, percentage }`；`label` 是稳定标签键、`name` 是展示名，按变体标签优先级排序；单额度时面板仍用无标签一行）。`quotas` 未进入响应 `required`，旧客户端忽略即可。`refresh=false` 使用 5 分钟内存缓存，缓存缺失/到期才读取官方 CLI；`refresh=true` 主动刷新，并发请求单飞。`available=false` 时数值字段只是稳定 schema 的零值占位（`quotas` 为空数组），UI 不展示这些占位值，而显示 `Quota unavailable`。`source` 标明是哪个 CLI 的 `/usage`（`QoderCN CLI /usage` 或 `Qoder CLI /usage`）。

`pricing` 方法接受可选 `{ "refresh": boolean }`，返回每模型倍率快照或 `null`。快照结构为 `{ models: [{ modelKey, qoderKey?, priceFactor, originalPriceFactor?, promotion? }], fetchedAt, source }`：`modelKey` 是目录展示名（与 catalog `modelID` 一致，如 `Qwen3.8-Max`），`qoderKey` 是 Qoder 内部 key（可选透传）；`priceFactor` 是当前生效倍率；`promotion` 携带 `active`、`discountFactor`、`beforePromotionPriceFactor`、`windowStart`、`windowEnd`、`timezone`、`badge`、`description`。`windowStart`/`windowEnd` 是每日重复的 `"HH:mm"` 墙上时间，`timezone` 为 IANA 时区（CN 是 `Asia/Shanghai`，海外是 `Asia/Singapore`），窗口可跨午夜。快照默认缓存 10 分钟，并发读取单飞；抓取失败或返回 `null` 时保留上一份成功快照，`fetchedAt` 只在成功时更新。默认提取器执行一次该变体 CLI 的 `--list-models`，通过注入 CLI 进程的 `JSON.parse` 捕获 hook 读取解密后的目录明文（**零模型调用**）；未登录、超时、形状不符或未捕获时返回 `null`，不编造数据。可用 `options.fetchPricing` 注入覆盖。`source` 里带实际使用的命令名（`qoderclicn --list-models …` / `qodercli --list-models …`）。

## TUI 侧边栏 Credits 面板

TUI 插件在 `sidebar.content` slot 追加常驻两段面板：CN 变体一段、海外变体一段，段间空一行。面板留在侧边栏滚动区内（不挂固定 footer，固定区在滚动区外会截断滚动），沉底靠 `opencode.json`（或 `opencode.jsonc`）的 `plugins` 数组顺序：**把本插件排在最后**即可沉底（面板整体在滚动区内，可滚动到达）。以下为面板格式示例（2026-11-17 采样，非实时；模型数量与倍率随账号套餐/服务端目录变化，额度随使用量变化）：

```
QoderCN (Credits)
Today 26.57
6,872 / 10,000（69%）
剩余 3,128 · 距离重置还有 10 天
模型倍率 ▸ 14
⟳ 刷新

Qoder (Credits)
Today 0.00
个人 4 / 570（1%）
共享资源包 1,727 / 5,000（35%）
剩余（个人）566 · 距离重置还有 10 天
模型倍率 ▸ 17
⟳ 刷新
```

点击 `模型倍率` 标题行展开后，该段的倍率段变成（节选，仅示意低峰进行中与待进入低峰两种促销态的文案格式；倍率数值随账号套餐/服务端变化）：

```
模型倍率 ▾
GLM-5.3 0.10x 低峰13时30分后恢复0.50x
Qwen3.8-Max 0.50x 3时30分后错峰4折
18:30 更新
```

- **Today** 来自本地 `calls.jsonl`，固定两位小数；stats 每 15 秒只读本地日志，不触发配额或模型调用。两个变体各自统计（0.2.x 的旧记录归 CN）。
- **额度行**来自对应 CLI 的官方交互式 `/usage`：已用/总额使用千分位，百分比四舍五入。单额度时一行无标签；同屏多个数值额度时逐行带标签（`PlanCreditsUsed`→个人、`OrgResourcePackage`→共享资源包、`Add-onCreditsUsed`→加量包），顺序按变体标签优先级。剩余/重置行取主额度（优先级最高者）的 remaining，重置天数按同屏唯一的 plan expiry（`expiresAt`）与当前时间向上取整且不为负。
- **模型倍率**来自 `pricing` RPC：每个模型一行「显示名 + 当前倍率 + 促销态」，尾行是本机时区的抓取时间。面板行用紧凑写法：低峰进行中显示 `低峰` + 到下一次 `windowEnd` 的倒计时 + `后恢复` + 恢复倍率（如 `低峰13时30分后恢复0.50x`）；未开始时显示到下一次 `windowStart` 的倒计时 + `后` + 去掉空格的徽标原文（如 `3时30分后错峰4折`），不乘 `discountFactor`。`/qoder models` 与 status 仍用带空格的长文案。窗口或时区缺失时只显示当前倍率。没有快照或没有有效倍率时整段隐藏，不展示占位值。窗口是每日墙上时间（`HH:mm` + IANA 时区），可跨午夜。
- **折叠模型倍率**：默认折叠，点击标题行在展开（`模型倍率 ▾` + 全部模型行 + 更新时间）与折叠（`模型倍率 ▸ {N}`，N 为有有效倍率的模型数）之间切换，再点一次折叠。折叠状态只存在组件内存，TUI 重启后恢复折叠，不写配置文件。Today 与额度区不受折叠影响；额度区单额度 2 行（金额 + 剩余/重置），多额度 2+N 行（N 为除主额度外的额外额度条数：每条额度一行金额，末尾再加剩余/重置行）。
- **手动刷新**：每段末尾固定一行 `⟳ 刷新`，点击后并发调用该变体的 `quota({ refresh: true })` 与 `pricing({ refresh: true })`，强制读取官方额度与模型倍率。刷新期间该行显示 `刷新中…`，重复点击被忽略。任一来源失败时保留旧数据且不弹 toast：额度已有旧值时继续显示旧值（从未取到额度时沿用 `Quota unavailable`），倍率保留上一份快照且抓取时间不前进。Today 仍来自本地日志，不参与刷新。
- **交互方式**：折叠与刷新都由侧边栏文本的鼠标左键点击触发（`onMouseUp`）；点击段标题等价于 `/qoder <变体> status`。这两处**未提供键盘可达路径**：面板行未设置 `focusable`，侧边栏 slot 也不在 OpenCode TUI 的焦点遍历范围内。
- **行宽与截断**：面板按 `sidebar.content` 的实测内容宽逐行截断，超宽行以 `…` 收尾，保证每行只占一行高——窄侧栏不会折行，尾部 `⟳ 刷新` 仍可滚到。模型数量与倍率随账号套餐/服务端目录变化，本文示例为 2026-11-17 采样（CN 14 个、海外 17 个模型），实际以 `/qoder models` 输出为准。
- 面板每 15 秒同时刷新 stats、quota 与 pricing；quota 与 pricing 命中服务端内存缓存（pricing 默认 10 分钟），并发读取单飞，不产生模型调用。
- 面板挂载、用户主动 status/refresh 或缓存到期时读取额度与倍率；并发读取单飞，进程超时/中止会清理 PTY。缓存只在内存中，不写额度或倍率文件。
- 官方输出缺少明确额度或到期时间、CLI 未登录或 PTY 失败时，只显示 `Today` 与 `Quota unavailable`，不估算、不显示伪零值。同一屏出现多个数值额度时全部逐行展示（带标签），主额度按变体优先级取第一个（CN 取 `OrgResourcePackage`，海外取 `PlanCreditsUsed`）用于剩余/重置行，**绝不相加**。status dialog 展示 `/usage` 来源、抓取时间与具体错误；多额度时逐条列出各额度，并只给一次 plan expiry（官方 `/usage` 只有一个 `PlanExpiresAt`，不给每条额度伪造独立到期时间）。
- 倍率抓取失败时保留上一份成功快照，抓取时间不前进；从未成功抓取时整段隐藏。倍率只进入面板与 `/qoder` 命令输出，不修改 `/models` 里的模型名称。
- stats RPC 失败时面板显示 `stats unavailable: …`；quota 失败不弹 toast。

## 配置项

插件选项来自 OpenCode 配置里 `plugins[].options` 对象，也可以用环境变量覆盖：

| 选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `cliPath` | `QODER_CLI_PATH` | 插件自带的 `node_modules/@qodercn-ai/qoderclicn/bundle/qoderclicn.js`，其次是 `PATH` 里的 `qoderclicn` | **CN 变体**的 Qoder CLI 可执行文件 |
| `variants.qodercn.cliPath` | `QODER_CN_CLI_PATH` | 同 `cliPath` | CN 变体 CLI 路径，优先级高于 `cliPath` |
| `variants.qoder.cliPath` | `QODER_INTL_CLI_PATH` | `PATH` 上的 `qodercli`，其次 `qoder` | **海外变体**的 CLI 路径；不随包分发 |
| `permissionMode` | `QODER_PERMISSION_MODE` | `bypass_permissions` | 透传给 `--permission-mode`。可选：`default`、`accept_edits`、`bypass_permissions`、`dont_ask`、`auto`。默认 `bypass_permissions`：Qoder 接进来的所有模型默认**不逐项确认文件修改和命令执行**，风险自担。显式配置 `default`、`accept_edits`、`dont_ask` 或 `auto` 仍按所配值生效；非法取值直接报错而不是退回默认值。环境变量为空白（空串/纯空格）视同未设置，走默认值；只有配置对象里显式传非法值才报错 |
| `timeoutMs` | `QODER_TIMEOUT_MS` | `1800000`（30 分钟） | 单次调用总超时，从 spawn 起计时且不被输出活动重置；超时后终止整个进程树，非法值直接报错。环境变量为空白视同未设置 |
| `idleTimeoutMs` | `QODER_IDLE_TIMEOUT_MS` | `180000`（3 分钟） | stdout/stderr 无活动超时；任一输出活动重置 idle timer，但不重置总超时。非法值直接报错，环境变量为空白视同未设置 |
| `contextLimit` | — | `200000` | 推导近似 token 数用的上下文窗口（见「限制与已知问题」的近似说明），非法值直接报错 |
| `pricingTtlMs` | `QODER_PRICING_TTL_MS` | `600000`（10 分钟） | 每模型倍率快照的内存缓存时长；抓取失败保留旧快照且不更新抓取时间，非法值直接报错。环境变量为空白视同未设置 |
| `pricingTimeoutMs` | `QODER_PRICING_TIMEOUT_MS` | `30000`（30 秒） | 单次倍率提取（`--list-models` + 捕获 hook）的总超时；超时终止整个进程树并保留旧快照。非法值直接报错，环境变量为空白视同未设置 |
| `logFile` | `QODER_LOG_FILE` | `${XDG_STATE_HOME:-~/.local/state}/opencode/qoder-provider/calls.jsonl` | JSONL 调用日志（目录 0700、文件 0600） |
| `additionalDirs` | — | `[]` | 字符串数组，逐个映射为 `--add-dir <dir>`，把这些目录**扩大**进 Qoder 的工作区范围（扩权操作，路径写错不会报错只会扩错地方） |
| `cliTools` | — | 不传（CLI 用自身默认） | 字符串数组映射为 `--tools <t>…`（允许清单）；传 `[]`（空数组）或 `""`（空串）都映射为 `--tools ""`，**禁用** Qoder CLI 全部内置工具；`["default"]` 恢复全部。传其他类型或数组里含空字符串会直接报错。不传该选项才是「CLI 自身默认工具集」；工具桥接开启时该次调用强制 `--tools ""`，与此选项无关 |
| `toolBridge` | `QODER_TOOL_BRIDGE` | `true` | 工具桥接开关：宿主 function 工具经文本协议交给模型执行（见下文「工具桥接」）。设为 `false` 退回旧行为：OpenCode 的 Subagent 与插件工具不可用，由 CLI 自带工具在 `--cwd` 工作。接受布尔值与 `true/false/1/0/on/off/yes/no`，非法值报错 |
| — | — | `ctx.location.directory` | CLI 的 `--cwd`，取当前 OpenCode 工作目录 |

示例（`opencode.jsonc`，OpenCode V2 的 `plugins` 数组写法；旧的 `plugin` 键已废弃）：

```jsonc
{
  "plugins": [
    {
      "package": "opencode-qoder-provider",
      "options": {
        "cliPath": "/usr/local/bin/qoderclicn",
        // 海外变体的 CLI 路径（不传则用 PATH 上的 qodercli → qoder）
        "variants": { "qoder": { "cliPath": "/usr/local/bin/qodercli" } },
        // 显式指定 default 可恢复逐项确认；不传时默认 bypass_permissions（风险自担）
        "permissionMode": "default",
        "timeoutMs": 1800000,
        "idleTimeoutMs": 180000
      }
    }
  ]
}
```

## 调用日志

每次模型调用写一行 JSON（**不含 prompt、不含回答、不含任何凭证**）。字段包括 `ts`、`variant`、`provider`、`model`、`actualModel`、`modelFallback`、`usageModelKey`、`usageModelKeys`、`credits`、`durationMs`、`isError`、`exitCode` 与 `sessionId`。`variant` 与 `provider` 都是变体 ID（`qodercn` / `qoder`），统计按变体分账。生命周期诊断为 `timeoutKind`（`idle`/`total`）、`lastEventType`、`lastEventAgoMs`、`sawStdout`、`sawStderr`、`sawTextDelta`、`sawResult`，只记录事件类型、布尔标志与耗时，不记录 stdout/stderr 正文。官方 `/usage` 探针不写 `calls.jsonl`。

同样的数据也会放进 AI SDK 的 `providerMetadata.qoder`，方便上层读取 Credits 与 Qoder session id。仓库不包含真实调用日志。

## 图片输入

两个变体（`qodercn` / `qoder`）都支持图片输入。prompt 里的 image part 与 `image/*` file part 会被收集为附件，每次调用把每张图写成系统临时目录里的一个文件，经 Qoder CLI 的 `--attachment <file>` 传入（附件可以与 stdin 纯文本 prompt 共存）；调用结束（成功、失败、超时、中断）后整个临时目录立即删除。文件扩展名按 mediaType 映射（`image/png` → `.png`、`image/jpeg` → `.jpg`、`image/webp`、`image/gif`），未知图片类型用 `.bin` 交给 CLI 按内容识别。

- **只支持图片**：非图片的 file part（如 PDF）抛 `UnsupportedMediaError`，不会静默丢弃。
- **payload 形态**：支持 `Uint8Array` 或 base64 字符串；远程 URL 不支持，会明确报错。
- **模型能力**：模型能否真正读图、识别精度以 Qoder 侧模型为准（两变体实测均可接收并读取图片内容）；插件不做二次校验。

## 工具桥接（Agent 与插件工具）

OpenCode 的工具（包括 Subagent、插件工具、TODO/文件/命令工具）不在 Qoder CLI 进程里，插件用文本协议把它们桥接给模型，两个变体共用同一条链路：

1. 每次调用把宿主的 function 工具清单（名称、描述、JSON Schema）与调用规则渲染进 `--append-system-prompt`，并用 `--tools ""` + `--strict-mcp-config` 临时禁用 CLI 内置工具与 MCP——避免模型调用宿主看不见的工具，也避免 CLI 自带 agent 悄悄接管任务。
2. 模型按协议回复 `<tool_call>{"name": "<tool>", "arguments": {...}}</tool_call>`，可以一次回复多个信封。
3. provider 把信封从正文里摘掉，翻译成 AI SDK `tool-call`；流式调用依次发出 `tool-input-start` / `tool-input-delta` / `tool-input-end` / `tool-call`，`finishReason` 记为 `tool-calls`。宿主执行工具后，下一轮以 `[tool]` 文本回传结果。

限制：

- 只桥接 function 工具；provider 自定义工具（`type: "provider"`，如内置 `web_search`）无法经文本协议执行，跳过并在 `warnings` 里说明。
- 桥接开启时 CLI 内置工具不参与该次调用。需要 Qoder 原生工具/agent 时设 `toolBridge: false`，但 OpenCode 的 Subagent 与插件工具将不可用。
- 调用靠模型遵循文本协议，偶尔可能泄漏信封或给出不合 schema 的参数；宿主校验失败时按普通工具错误处理。

## 限制与已知问题

- **双超时与取消**：`idleTimeoutMs` 只衡量 stdout/stderr 静默，`timeoutMs` 限制总运行时长；超时错误分别包含无活动毫秒数或总超时毫秒数。`doGenerate` 抛错，`doStream` 投递 error part；idle/total/abort 均终止整个进程树并清理 timer/listener。
- **官方额度只读 CLI 输出**：配额 helper 经 `node-pty` 自动处理 trust 页，除 trust 确认外只发送 `/usage`，不发送模型 prompt。缺字段、企业套餐不支持或输出口径不一致时返回 `unavailable`，多项额度没有官方总计时不会聚合。OpenCode 的 Bun 运行时通过同一插件内的 Node 桥接执行 PTY；需要 `node` 在 PATH 中，也可用 `QODER_NODE_PATH` 指定。
- **两个变体的 `/usage` 屏不同**（2026-11-16 取证）：CN 屏是 `QoderCNPlan:` + `OrgResourcePackage:9749/10000`（`PlanCreditsUsed:N/A`），海外 Teams 屏是 `QoderPlan:` + `PlanCreditsUsed:4/570` 与 `OrgResourcePackage:0/5000`（组织共享资源包）。额度标签按变体定优先级：CN 取 `OrgResourcePackage`，海外取 `PlanCreditsUsed`；同屏全部数值额度经 `quotas` 数组逐行展示（个人/共享资源包/加量包），主额度用于剩余/重置行，**绝不相加**。
- **倍率提取只读目录明文**：默认提取器执行一次该变体 CLI 的 `--list-models`（CN 是 `qoderclicn`，海外是 `qodercli`），经 `NODE_OPTIONS` 注入 `JSON.parse` 捕获 hook 读取 CLI 解密后的模型目录；只含模型名、倍率与促销窗口，不请求账户接口、不运行模型、不读取凭证。捕获文件写在系统临时目录，读取后立即删除；`NODE_OPTIONS` 与既有值合并而不是覆盖。CLI 未登录、超时、输出形状不符或未捕获时返回 `null`，面板与命令隐藏倍率信息并保留上一份成功快照。
- **促销时区随变体**：CN 是 `Asia/Shanghai`，海外是 `Asia/Singapore`；窗口都是每日墙上时间 `22:00`–`08:00`，徽标文案不同（CN「错峰 4 折」、海外「错峰2折」）。
- **stdin 体积上限**：`qoderclicn` 会把超过 **8388608 字节** 的 stdin 截断（截断时只打印一行 warning；该上限在 1.1.85 上实测，随包的 1.1.90 未重新实测）。本插件在 **7340032 字节（7 MiB）** 就直接报错 `PromptTooLargeError`，避免静默截断导致回答莫名其妙地少一截。
- **上下文 token 展示值是近似推导**：Qoder CLI 的 `usage`/`modelUsage` token 计数恒为 0（OpenCode 因此显示不出 `tokens / % used` 指示）。插件在 token 计数缺失或为 0 且 `usage.context_usage_ratio` 有效（0<r≤1）时，按 `round(ratio × contextLimit)` 推导 `inputTokens.total`；真实非零 token 永远优先、不被覆盖。`contextLimit` 默认 200000、可配置（同时写入模型元数据的 `limit.context`，**不是 Qoder 实测上限**）；`providerMetadata.qoder` 记录 `contextUsageRatio` 与 `approximatedContextTokens` 标志标明该值为估算。
- **支持文本、图片与工具**：capabilities 为 `{tools: true, input: ["text", "image"], output: ["text"]}`。图片经 CLI `--attachment` 传入（详见「图片输入」），工具经文本协议桥接（详见「工具桥接」），非图片文件仍会**明确报错**（`UnsupportedMediaError`），不会静默丢弃。
- **工具桥接默认开启**：宿主 function 工具经 `<tool_call>` 文本协议执行；provider 自定义工具不支持，Qoder 原生工具在桥接期间停用。`toolBridge: false` 退回旧行为（CLI 自带工具可用、OpenCode 工具不可用）。
- **prompt 被拍平成纯文本**：宿主 system 消息经 `--append-system-prompt` 单独传入（工具桥接时会再追加协议说明）；user/assistant/tool 序列化成带 `[user]`/`[assistant]`/`[tool]` 前缀的文本写 stdin，工具调用序列化为 JSON，角色语义会有损失。
- **无会话续传**：每次调用都带 `--no-session-persistence` 起独立 CLI 进程，完整对话每轮重新写 stdin（受 7 MiB 上限约束），不依赖 Qoder session 续聊。
- **采样参数不透传**：`temperature`、`topP`、`stopSequences` 等 AI SDK 选项没有对应的 CLI flag，会被忽略；`maxOutputTokens` 是唯一透传的采样参数。
- **输出上限固定**：模型元数据的 `limit.output` 固定为 32000（非 Qoder 实测值）；需要更大输出时用调用级 `maxOutputTokens`。
- **推理档位不可选**：CLI 支持 `--reasoning-effort` / `--thinking`，插件暂未暴露为模型选项，推理水平由 CLI 与模型默认值决定。
- **CLI 自有配置仍会生效**：插件只经命令行参数传参，不读写 `~/.qoder` / `~/.qoder-cn` 的配置文件；桥接调用用 `--strict-mcp-config` 屏蔽用户级 MCP，非桥接调用沿用 CLI 自身的 MCP / hooks / 权限配置。
- **不传 `--input-format`**：`--input-format=stream-json` 会让 CLI 以 stdin 事件流协议读取输入，与纯文本 prompt 不兼容；prompt 只能以纯文本写 stdin。
- **流式**：`doStream` 用 `-o stream-json --include-partial-messages`（隐藏参数，1.1.90 bundle 实证）驱动 CLI，把 `content_block_delta` 的 `text_delta` 实时映射为 AI SDK `text-delta`，`thinking_delta` 映射为 `reasoning-delta`（不混入正文）；最终 `assistant` 事件不会重复输出已流式的文本。流式路径由解析器增量消费 stdout 字节，**不保留/解码原始 stdout 副本**（截断检测照常，超限即失败）。CLI 未产生任何 `text_delta` 时（旧版本或空 text 块）：先合法关闭所有已打开的块，再用全新 id `qoder-text-fallback` 把 `result` 的完整文本作为一个新 text 块输出，**不会复用或重开已关闭块的 id**。`doGenerate` 保持单文档 `-o json`。流中缺少 `result` 事件会明确失败。
- **maxOutputTokens 透传**：调用级 `maxOutputTokens`（正整数）映射为 CLI `--max-output-tokens <n>`，`doGenerate`/`doStream` 一致；非正整数、浮点、NaN 等非法值**忽略该参数**（不传 flag、不报错），不会让调用失败。
- **finishReason 映射**：CLI `stop_reason` 为 `max_tokens` / `max-output-tokens` 时 unified finish reason 映射为 `length`；`is_error` 优先映射为 `error`，其余为 `stop`。
- **模型回落判定**：只有 CLI stderr 明确输出 `Model ... falling back to ...` 或 `Model ... using ... instead` 才认定为回落。`result.modelUsage` 的 key 只作为 `usageModelKey` / `usageModelKeys` 记录，不参与回落判定，也不冒充 `actualModel`；`usageModelKey` 选取**第一个有 credits 或非零 token 的 entry**（真实调用中 Auto 会先记一条全 0 的 `auto`，真实用量在有 credits 的 `fast` 上），全部为 0 时退回第一个 key。没有明确 stderr 时，`actualModel` 使用请求模型，DeepSeek-Flash 或 Fast 搭配 `modelUsage.auto` 不会产生警告或失败。
- **明确回落处理**：`execute` 记录 Credits、session、错误状态、exitCode 与耗时后抛出 `ModelFallbackError`。`doGenerate` 拒绝该调用，`doStream` 发出 error part，均不返回成功结果、不自动重试。
- **会话标题会额外调一次模型**：OpenCode 用会话模型生成会话标题，这是 OpenCode 自带行为、与插件无关，会多消耗一次 Credits。可在 OpenCode 配置里设 `small_model` 指向便宜的模型来避免。
- **CLI 缺失/未登录**：调用会失败并给出安装或登录指引；占位模型仍可选择。
- 插件不修改任何全局默认模型，也不写入 Qoder 之外的目录。
- **`/qoder` 同名命令有两处**：TUI 的 slash（keymap）与服务端命令。TUI 里 keymap 先接管，结果进 dialog、session inbox 不新增消息；非 TUI 客户端走服务端命令，结果进 session inbox。两条路径的回答内容一致。
- **OpenCode 的 HTTP API 始终要求 basic auth**：`opencode serve` 会生成服务端口令（`OPENCODE_PASSWORD` 可指定），远程调用需要 `Authorization: Basic base64(opencode:<password>)`。这与本插件无关。

## 安全

- **不含凭证**：插件代码与仓库不包含任何密钥、token、凭据或真实调用日志；密钥只可能存在于本机的 Qoder CLI 登录态里，插件不读取、不转发、不落盘。
- **日志脱敏**：`calls.jsonl` 只记录模型名、Credits/用量元数据与 session 标识，**不含 prompt、回答与任何凭证**；日志目录按 0700、文件按 0600 创建，对已存在的文件 best-effort 收紧权限。
- **本地运行边界**：模型调用 spawn 本机已登录的 `qoderclicn`，工作区限定在 `--cwd`（当前 OpenCode 目录）；配额读取通过本机 CLI 的官方 `/usage` 获取，由 Qoder CLI 自己使用既有登录态访问服务，插件不读取/解密 token，也不直接发送 Bearer HTTP 请求，不启动 HTTP 代理。`additionalDirs`（`--add-dir`）与 `cliTools`（`--tools`）会改变模型调用的工作区/工具边界——前者**扩大** Qoder 可写目录、属扩权操作，后者可用 `--tools ""` 完全禁用 Qoder 内置工具。超时/取消/中止都会终止整个子进程树（Windows 走 `taskkill /t /f`）。
- **倍率捕获边界**：捕获 hook 只包装 `JSON.parse`，把含 `price_factor` 的目录明文写到系统临时目录，读取后删除；不接触 prompt、回答、token 或登录凭证。`NODE_OPTIONS` 只追加 `--import`，不覆盖已有参数。
- **Qoder CLI 内层权限默认放开**：未显式配置 `permissionMode` 时以 `bypass_permissions` 运行，Qoder 不再逐项确认文件修改和命令执行，模型可修改 `--cwd` 内文件并执行命令，**风险自担**。显式配置 `default` 可恢复逐项确认；`additionalDirs` 等工作区边界仍独立生效。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `index.ts` | OpenCode 服务端插件。`Plugin.define` + `ctx.provider.transform` 注册两个 provider（CN / 海外）与各自模型目录，`ctx.command.transform` 注册 `/qoder`，`ctx.aisdk.hook("sdk")` 按 provider ID 把各自的 provider runtime 交给 OpenCode，`ctx.rpc.register` 注册 `qoder` RPC |
| `tui.ts` | OpenCode TUI 插件。注册 `/qoder` slash 命令，调用 `qoder` RPC 拿结果，用原生 dialog 显示；并在 `sidebar.content` slot 追加 Credits 面板（沉底由 `plugins` 数组顺序决定，本插件排最后） |
| `panel.tsx` | 侧边栏 Qoder Credits 面板：两个变体各一段，15 秒读取本地 stats、quota 与 pricing 缓存，展示今日消耗、官方额度与每模型倍率；点击段标题打开该变体的 status 对话框；点击「模型倍率」标题折叠/展开该段；点击末尾 `⟳ 刷新` 并发强制刷新额度与倍率 |
| `src/panel-model.mjs` | 面板状态控制器：stats/quota/pricing 取数、手动刷新（防重复、失败保留旧值）与折叠开关（默认折叠） |
| `src/variants.mjs` | 双变体描述符：provider ID 与显示名、CLI 解析顺序（CN 随包 CLI 优先 / 海外只走 PATH）、额度标签优先级、命令 token 与模型引用前缀 |
| `rpc.ts` | RPC 契约：`qoder` id、`execute`、`stats`、`quota`、`pricing` 四个方法（入参可选 `variant`），server 与 TUI 共用 |
| `provider.mjs` | provider runtime。导出 `createQoder(options)`，返回带 `languageModel(modelID)` 的 provider（AI SDK **LanguageModelV3**） |
| `src/options.mjs` | 选项与默认值解析（变体、CLI 路径、权限模式、超时、日志位置） |
| `src/models.mjs` | Qoder 模型名 ↔ OpenCode 模型 ID 映射、目录解析 |
| `src/prompt.mjs` | prompt 序列化（system/user/assistant/tool）、图片附件收集与字节上限检查 |
| `src/cli.mjs` | spawn Qoder CLI、附件临时文件与 `--attachment` 传参、stdin 写入、进程树终止、独立 idle/total 双超时与活动诊断 |
| `src/result.mjs` | CLI 结果 → AI SDK V3 结果、Credits 提取、回落检测 |
| `src/logger.mjs` | JSONL 调用日志（无 prompt、无凭证） |
| `src/catalog.mjs` | `--list-models` / `--version` 调用 |
| `src/command.mjs` | `/qoder` 的变体 token 与子命令解析，以及状态/目录/登录文案（server 与 TUI 共用同一份） |
| `src/stats.mjs` | 调用日志 → 面板数据聚合（total/today/last，按变体分账，纯函数、时钟可注入） |
| `src/credits.mjs` | Today、官方额度、到期天数、错误行与手动刷新行（`⟳ 刷新`）的纯格式化 |
| `src/quota.mjs` | 官方 `/usage` 解析（主额度按变体标签优先级 + `quotas` 收集同屏全部数值额度）、5 分钟缓存、单飞与 status 文案 |
| `src/pricing.mjs` | 每模型倍率快照的 10 分钟缓存、单飞、失败保留，每日时段换算，以及倍率/倒计时/促销态与倍率段面板行文案 |
| `src/pricing-qoder.mjs` | 默认倍率提取器：`--list-models` + 捕获 hook、形状校验、超时/进程树终止与失败降级（来源文案带实际命令名） |
| `src/pricing-capture.mjs` | 注入 CLI 进程的 `JSON.parse` 捕获 hook；只在设置捕获目录时把目录明文写入临时文件 |
| `src/quota-cli.mjs` | `/usage` 交互流程、trust 处理、面板/桥接选择与进程清理 |
| `src/quota-pty.mjs` | Bun 运行时的 Node 桥接入口，执行同一次 `node-pty` `/usage` 并 JSON 回传 |
| `src/poller.mjs` | 15 秒轮询器（timer 可注入） |

OpenCode 通过 `aisdk:file://<绝对路径>/provider.mjs` 解析 provider；该模块导出 `createQoder(options)`，OpenCode 随后调用 `sdk.languageModel(modelID)`。

## 开发与测试

```bash
npm ci
npm test          # Bun 全量测试
npm run test:node # Node 24 经 tsx 加载器运行全量 TypeScript 测试（含 .tsx 面板模块）
npm run check     # tsc --noEmit
```

另有可选的 `npm run check:catalog`：会用真实 Qoder CLI 读取一次 `--list-models`，只用于本地人工检查；自动化测试与 CI 不运行它。

测试用 `test/fixtures/fake-qoder.mjs`（CN，默认模型集）与 `test/fixtures/fake-qoder-intl.mjs`（海外，默认 16 模型集，夹具固定值，非线上目录）与假 PTY，**不消耗 Credits、不联网、不需要登录**。覆盖：模型 ID 与冲突、prompt 序列化与媒体报错、doGenerate/doStream V3 事件、明确回落拒绝、Credits metadata 与日志脱敏、默认/显式权限 argv、idle/total/abort 错误传播、父子进程清理与活动诊断。官方额度使用录制 `/usage` 输出，覆盖解析、缺字段/多额度 unavailable、千分位/百分比/到期天数、5 分钟 TTL、单飞、超时/abort 清理与零模型 prompt。倍率覆盖每日时段换算（跨午夜/非本机时区/非法输入）、提取器纯解析与 fake CLI 捕获集成、`NODE_OPTIONS` 合并、超时/失败降级、10 分钟 TTL、单飞、失败保留旧快照、默认 `null`、倍率/倒计时边界、促销三态与面板/命令文案。

另外覆盖 TUI 与 RPC：四个 RPC 方法的形状（含可选 `variant` 入参）、`/qoder` slash 注册、侧边栏 slot 注册、命令成功 dialog 与 RPC 失败 toast、refresh 模型列表与倍率刷新、server command/RPC 文案一致、stats 不读取官方额度、插件卸载清理；面板侧覆盖本地 stats 聚合、真实额度与 unavailable 行、模型倍率段三态（无数据隐藏、低峰进行中、待进入低峰）、模型倍率折叠两态（默认折叠）与计数、刷新行文案、手动刷新并发 `refresh: true`、刷新中防重复、失败保留旧值、15 秒本地轮询和停止清理。

双变体覆盖：两个 provider 的注册（ID/显示名/模型目录/scoped aisdk hook）、变体 token 与子命令解析（`cn`/`qodercn`/`intl`/`qoder`/`global`）、每变体独立的额度与倍率存储、按变体分账的 Today 与累计消耗、额度标签优先级（CN `OrgResourcePackage` / 海外 `PlanCreditsUsed`，绝不相加）、倍率来源文案带实际命令名、旧版日志归 CN、CLI 解析顺序（CN 随包 CLI 优先 / 海外只走 PATH）。

## 许可

MIT
