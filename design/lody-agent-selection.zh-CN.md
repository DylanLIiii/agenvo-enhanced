# Lody 多 Agent 配置选择

状态：阶段 0 与阶段 1 已实现；阶段 2 之后未实现。下文“当前限制及位置”记录的是实现前的闸门，其代码已替换，保留作为设计依据。本文回答“Lody Session 的调用者如何选择更多 Agent 配置”，并记录由此暴露的事件流缺口；事件流本身的重新设计另行立项。总体连接模型见 [Lody Connector](lody-connector.zh-CN.md)，共同术语见 [MCP 与 Connector 设计原则](agent-management.zh-CN.md)。

## 结论

当前限制是 Agenvo 自己的闸门，不是 Lody 的原生限制。Lody 0.104.0 原生支持 9 个内置 provider、约 38 个 ACP registry Agent 与自定义 ACP 启动；其派发路径对任意 Agent 配置接受 `modeId`、`modelId`、`configOptionValues`，并按该配置的 ACP capability 校验。Agenvo 目前只放行内置 Codex 与 Claude，并强制附带 full-access 模式。

建议分步放开：

1. **按原生能力识别 full access，而不是按 agentType。** 去掉 `["codex","claude"]` 白名单；给 `send` 增加可选 `modeId` 与 `configOptionValues`，由调用者显式选择；自动批准只在 full-access 策略下运行。
2. 先用已有的 mode 机制接入 DeepSeek Harness，再增加 `configOptionValues` 写入以接入 Grok 与 Kimi。
3. registry 与 custom 配置只接受调用者显式给出的 mode/选项，不自动套用 full access，权限请求保持显式。

## 当前限制及位置

所有执行入口（`create` 与 `send`）都经过同一个函数，[`LodyWorkspace.executionConfig`](../apps/lody/src/workspace.ts#L226)：

```ts
if (
  config.cliType !== "builtin" ||
  !["codex", "claude"].includes(config.agentType)
)
  throw new Fault("unsupported_capability",
    "Full-access execution currently supports builtin Codex and Claude configurations");
const ids = config.agentType === "codex"
  ? ["agent-full-access", "danger-full-access"]
  : ["bypassPermissions"];
// supportedModes = capabilities.modes[*].id ∪ configOptions[category==="mode"].options[*].value
const modeId = ids.find((id) => supportedModes.has(id));
if (!modeId) throw new Fault("unsupported_capability",
  "The native capability catalog does not advertise a supported full-access mode");
```

- 云端与本地共用该函数，`config` 来自机器 Flock 文档的 `agentConfig` / `acpCapability` 行，两种模式没有分叉。
- `create` 调用它（[workspace.ts:303](../apps/lody/src/workspace.ts#L303)）并把 `cliType/agentType` 写入 Session；`send` 再次调用并核对 provider 未变（[workspace.ts:432-441](../apps/lody/src/workspace.ts#L432)）。因此被拒绝的配置连 Session 都建不出来。
- 返回的 `modeId` 写入用户轮次的 `inputConfig`（[workspace.ts:455](../apps/lody/src/workspace.ts#L455)）。`modelId` 是唯一的调用者可选项（[protocol.ts:36](../apps/lody/src/protocol.ts#L36)）；`createInput` 与 `sendInput` 都是 strict 对象，没有 `modeId`、`configOptionValues`。
- `appendUserTurn` 把 `inputConfig` 声明为 `Record<string,string>` 并逐键写入 `LoroMap`，不能写嵌套的 `configOptionValues`。
- `catalog` 本身不过滤：它返回所有配置的 `id/name/cliType/agentType` 与原始 `acpCapability`，所以“可发现”已成立；调用者看不到的是“Agenvo 是否会执行”。
- 测试只覆盖 Codex：`tests/fixtures/lody-cloud.ts` 与 `tests/system/lody-events.test.ts` 的 agentConfig 均为 `builtin/codex`。Claude 路径只有闸门代码，没有系统级验证。

Paseo 有相同形态的闸门（[paseo.ts:24,57](../apps/paseo/src/paseo.ts#L24) 的 `provider: codex|claude`）；本文不处理，只供对照。Herdr 则明确不设白名单（`kind` 与 `args` 原样转发，见 [Herdr 设计](herdr-connector.zh-CN.md)），OpenCode 与 Codex app-server 在服务端内部设置全允许策略。

## Lody 原生 Agent 配置版图

证据来自 `npm pack lody@0.104.0`（仓库固定版本）的 `dist/index.js`，行号为该文件行号。这是静态源码与随包 README，**未对非 Codex provider 做运行验证**。

| 类别 | 内容 | 依据 |
| --- | --- | --- |
| `cliType` | `builtin` / `registry` / `custom` | `AgentConfigCliTypeSchema`（L6287） |
| 内置 | kimi、devin、grok、claude、codex、pi（托管运行时）；deepseek、bub、dimcode | `MANAGED_BUILTIN_RUNTIMES`、`BUILTIN_AGENTS`（L5466-5492） |
| registry | 硬编码 ACP registry，约 38 项：claude-p、cursor、gemini、github-copilot-cli、goose、opencode、qwen-code、mistral-vibe 等 | `HARDCODED_REGISTRY_ACP_AGENTS`（L18299 起） |
| custom | `customAcp` 启动规格，任意 ACP 服务 | `isValidDaemonLaunchConfig`（L110833-110848） |

原生执行入口对所有配置一视同仁，不按 agentType 分流。`validateTurnModeAndModel`（L245761）与 `validateTurnConfigOptionValues` 以 capability 校验 `modeId`/`modelId`/`configOptionValues`，错误为 `Unsupported ACP mode for the selected agent`；但**阶段 0 探测表明，这套校验只在原生自己的 session 创建/Role 路径上生效，写入用户轮次 `inputConfig` 的路径不经过它**（见下节）。随包 README 也说明 agent-config 发现暴露 `runConfig.modes/configOptions`，创建时接受 `modeId` 与 `configOptionValues`，并以 Grok `permission_mode: "ask"` 为例，注明 ACP mode `default` 并非权限策略。

### 各内置 provider 的权限表达

| provider | 内置默认 mode | full access 的原生表达 | 依据与状态 |
| --- | --- | --- | --- |
| codex | `agent-auto-review` | mode `agent-full-access`（或 `danger-full-access`） | `CODEX_STATIC_MODES`（L5635）；Agenvo 已支持并有系统测试 |
| claude | `auto` | mode `bypassPermissions` | `CLAUDE_STATIC_MODES`（L5745）；仅代码，无系统测试 |
| deepseek | `workspace-write` | mode `danger-full-access`，位于 `category: "mode"` 的选项 | `DEEPSEEK_HARNESS_PERMISSION_PRESETS`（`chunks/acp-*.js`）与 L5610-5625。与 Codex 的旧 id 相同，现有识别逻辑即可命中 |
| grok | `default` | 配置项 `permission_mode = always-approve`，category 为 `_permission`，**不是 mode** | L5942。守护进程对 Grok 在该值下自动批准工具权限（`getBuiltinToolPermissionOutcome`，L210894） |
| kimi | `auto`（静态）；运行时为 `default` | 运行时：mode `yolo`（`modes` 与 `category: "mode"` 选项均包含）；静态数据曾列为 `_permission` 类 `permission_mode=yolo` | **阶段 2 运行验证**：Kimi Code 2.0.2 ACP 服务（`session/new`）返回 `mode` 选项 `default/plan/auto/yolo` 与同名 `modes`，没有 `permission_mode`。静态数据过时；Agenvo 两种形态都识别 |
| pi、devin、bub、dimcode | 无 | 静态数据中未发现 | 需要运行时 capability 才能判断 |

原生客户端自己的“full access”识别表是 `classifyPermissionModeFace`（L5777）：`agent-full-access`、`danger-full-access`、`bypassPermissions`、`yolo`、`always-approve` 归为 full-access，其余注释为 “Unknown / third-party (not adapted)”。这是 Agenvo 可以对齐的原生依据，也说明这些 id 的含义只对内置 provider 可靠。

两个由此得出的约束：

- `getSupportedTurnSelectorIds`（L245745）只把 `capability.modes` 和 `category === "mode"` 的选项视为 mode。Grok、Kimi 的 `_permission` 选项必须走 `configOptionValues`，Agenvo 现有的 `modeId` 路径无法表达它们。
- 内置 provider 缺省 mode 并不是 full access（claude 缺省 `auto`，codex 缺省 `agent-auto-review`，由 `withBuiltinDefaultTurnMode` 注入，L245628）。所以 Agenvo 是否附带 full-access 是产品选择，不是原生要求。

## 其他 Agent 配置今天会出什么问题

| 方面 | 现状与证据 | 结论 |
| --- | --- | --- |
| 配置校验 | 仅 Agenvo 闸门拒绝；原生接受 | 纯 Agenvo 闸门 |
| 权限模式 | 闸门同时承担“找到 full-access 标识”；Grok/Kimi 需要 `configOptionValues`，Agenvo 不能写 | 需要新增参数，不只是去闸门 |
| 自动批准 | `approvePermissions` 对所有被 Agenvo 发送过输入的 Session 自动选 `allow_once`，不看本轮 mode（[workspace.ts:593](../apps/lody/src/workspace.ts#L598)）。一旦允许调用者选 `ask` 之类的 mode，该逻辑会让选择失效 | **必须随放开一起修改**：只在 full-access 策略下自动批准 |
| 提问与批准区分 | 以 `_meta` 是否存在判断是否是用户问题（[workspace.ts:603](../apps/lody/src/workspace.ts#L608)）。只对 Codex 的请求形态有测试，其他 provider 的 `_meta` 约定未验证 | 保守行为（不确定则留给调用者），可保留 |
| 模型与 mode 校验 | 探测：非法 `modeId`、`modelId`、选项值在用户轮次路径上**不被守护进程拒绝**，原样转给 ACP Agent（`set_mode`/`set_model`/`set_config_option`），由 Agent 自己决定 | Agenvo 必须在写入前对照 capability 校验，否则错误值只会表现为 Agent 侧的行为或错误 |
| 取消 | 按 `turnId` 调用 `session/cancel`，与 provider 无关 | 无需改动 |
| steer | 原生按 provider 协商能力（`lody.steering`，L210814-210835）。探测：对不支持 steer 的配置，守护进程返回 `applied:false, disposition:"unsupported", recoveryOwned:true`，并把该输入作为后续轮次重新排队（日志 `Undelivered steer … requeued as a follow-up turn`）；没有活跃轮次时为 `disposition:"no-active-turn"`，同样 `recoveryOwned`。Agenvo 现在把所有 `applied:false` 映射为 `native_steer_not_applied`/`unknown`（[workspace.ts:488](../apps/lody/src/workspace.ts#L488)） | 原生拒绝并不意味着输入丢失：守护进程接管恢复。Agenvo 应原样返回 `disposition`/`recoveryOwned`，说明输入已由 Lody 作为后续轮次排队，而不是 unknown，也不是 rejected |
| 历史形态 | `readTurn` 原样返回原生轮次，不解释 provider 差异 | 形态差异由调用者读取 |

## 阶段 0 探测结果

方法：`tests/support/acp-agent.mjs` 是仓库内的最小 ACP Agent（记录每个收到的请求），以 `cliType: "custom"` 注册到固定的 `lody@0.104.0` 本地守护进程（平台常量组装同 `nativeLody`），不使用任何账号。直接按 Agenvo 的写入方式追加用户轮次，但在 `inputConfig` 中写入嵌套 `configOptionValues`。

| 问题 | 静态推断 | 探测结果 |
| --- | --- | --- |
| custom 配置能否派发 | 应能 | **确认**。守护进程启动 Agent，执行 `initialize → session/new → set_mode → set_model → set_config_option → prompt`，结果写回历史，`author` 携带 `agentConfigId/cliType/agentType` |
| `modeId`/`modelId`/`configOptionValues` 是否被守护进程转发 | 应能 | **确认**，包括 `_permission` 类选项：`set_config_option(permission_mode, always-approve)`；嵌套 `configOptionValues` 是 `LoroMap` 即可被识别（`session/new` 的 `_meta.lody.sessionConfig` 也携带它） |
| 守护进程是否校验这些值 | **应校验** | **不成立**。`mode=nope`、`model=nope`、`permission_mode=bogus` 均被原样送给 Agent，capability 行已存在时也一样 |
| capability 来源 | 种子行 | 守护进程在首次使用 Agent 时探测并写入 `acpCapability`（`provenance: "runtime"`、`cacheVersion: 9`，含 `modes/models/configOptions`）；配置刚创建的数秒内该行不存在 |
| 权限请求形态 | 无 `_meta` 为普通执行权限 | **确认**：`tool_call` 条目含 `permissionRequest{requestId, options[allow_once, reject_once]}`，无 `_meta`，轮次保持未完成，`interactions.list` 可见 |
| steer 不被支持 | 报告 unknown，留下 `pending_apply` | **修正**：见上文 steer 一行，守护进程 `disposition: "unsupported"`、`recoveryOwned: true` 并重新排队为后续轮次 |

两处修正已写入上文：守护进程不校验用户轮次的 mode/model/选项，Agenvo 必须自己校验；steer 的未应用结果由守护进程接管恢复，不应再被报告为 unknown。选择模型、默认行为与阶段划分不变。capability 行缺失（尚未探测）时，Agenvo 不附带权限设置，也不自动批准。

## 选择模型

发现与选择路径不变，只补足缺的参数，沿用[描述能力](agent-management.zh-CN.md#描述能力保留原生语义)的术语：

1. `lody.catalog` → 机器 → `agentConfigs`（`id/name/cliType/agentType`）与 `capabilities`（原生 `modes`、`configOptions`、`models`）。这是唯一的发现入口，不新增“可执行列表”，避免 Agenvo 复述原生能力。
2. `lody.sessions.create`（create work context）：`machineId` + `agentConfigId` 不变。放开后不再因 agentType 被拒绝；配置不存在、属于其他机器时仍拒绝。
3. `lody.sessions.send` / `steer`（submit input）新增可选 `modeId` 与 `configOptionValues`（`Record<string, string|boolean>`），原样写入 `inputConfig`，由守护进程校验。`modelId` 保持。

调用者未传 `modeId`/`configOptionValues` 时的默认权限行为：

| 配置 | 默认行为 |
| --- | --- |
| 内置，capability 中有原生认可的 full-access 标识（codex、claude、deepseek 的 mode；grok、kimi 的 `permission_mode`） | 与现在一致：附带 full access，并自动批准普通执行权限 |
| 内置，无认可标识（pi、devin、bub、dimcode） | 不附带权限设置，使用原生缺省；权限请求作为显式 interaction 留给调用者 |
| registry、custom | 同上；`yolo` 之类 id 在第三方 Agent 中含义未知，不自动套用 |

调用者显式传入 mode 或选项时，以调用者为准，并关闭对该轮的自动批准。这符合“执行约定由配置者通过实例 context 声明，调用者选择原生参数”的项目约定，避免 Connector 为落实约定增加 Agent 类型白名单。

保持“可发现但被拒绝”的情形，并给出原生原因：配置缺失或属于其他机器；`cliType`/`agentType` 与 Session 记录不一致；显式 `modeId`/`modelId` 不在 capability 中；capability 行缺失（守护进程尚未探测）。这些是原生事实，不是 Agent 类型限制。

Lody Agent Role（`agent-role list/get`，可覆盖手工配置）是另一条原生选择路径，本期不接入，见备选方案。

## 事件流含义

放开更多 Agent 后事件流会遇到下列问题。这是缺口清单，不是本期设计；证据为当前代码。

| 缺口 | 证据 | 影响 |
| --- | --- | --- |
| 文档订阅回调只发 `history.updated`；Session 元数据由 `repo.watch` 以原生 `doc-metadata` 发出，机器 capability 变化不发事件 | 文档订阅回调只处理 `history` 路径（[workspace.ts:477](../apps/lody/src/workspace.ts#L477)）；元数据事件见 [workspace.ts:197](../apps/lody/src/workspace.ts#L197)。本表此行在阶段 3 调查后更正，见[Lody 事件流设计](lody-events.zh-CN.md) | 状态与待处理权限（`status: requestPermission`）已有原生证据，但没有 Agenvo 身份说明，也无法按类型过滤“需要输入” |
| 超过 24KB 的事件被替换成 `{sessionId, truncated, omittedBytes}`，丢失 turn 标识 | `emit`（[lody.ts:387](../apps/lody/src/lody.ts#L397)） | 工具输出更长的 provider 更易触发；消费者不知道是哪一轮 |
| 事件没有 agent 标识 | `native` 只含 `turn`；`threadId` 是 Session | 消费者无法按 provider 解读轮次形态，需再读 Session 元数据 |
| 文档订阅数上限 128 且永不驱逐 | `docs.size >= 128`（[workspace.ts:362](../apps/lody/src/workspace.ts#L362)）；`docs` 仅失败时删除，`history`、`turn`、`interactions` 都经 `document()` 打开 | 读取历史也占名额；Session 变多后更早触顶 |
| 断线后所有文档订阅丢失，需逐个重新订阅 | `onDisconnect` 清空 workspace 并发 `agenvo.resync_required`（[lody.ts:225](../apps/lody/src/lody.ts#L248)） | 重建成本随 Session 数线性增加 |
| 自动批准依赖进程内 `controlled` 集合 | [workspace.ts:461](../apps/lody/src/workspace.ts#L461) | 重连或重启后既有 Session 的权限请求停在待回应状态 |
| steer 的原生处置被报告为 unknown | 见上节 | 消费者无法区分“守护进程已接管并排队”与“结果未知” |
| 缺口恢复边界 | 结构性变更只回放最后 50 条，超过则 `onGap`（[workspace.ts:391-394](../apps/lody/src/workspace.ts#L391)） | 大历史需调用者主动重读 |

本期只处理与放开直接相关的两项：自动批准受策略约束；steer 的原生处置（`disposition`/`recoveryOwned`）如实返回。其余留给事件流设计任务，建议切入点：权限请求与 Session 状态事件、截断事件保留 `turnId`、事件携带 `agentConfigId`、文档订阅与读取分离并可驱逐。

## 阶段 2：`_permission` 类选项的验证与账号依赖

方法：用固定版本的原生运行时直接发起 ACP `initialize` / `session/new`，记录实际 capability 形态。Kimi 使用 `@moonshot-ai/kimi-code@2.0.2` 与指向本地端口的虚拟 provider 配置（`KIMI_CODE_HOME` 下的 `config.toml`），不登录账号；Grok 使用 Lody 随包的 `grok-acp.js` 适配器与 `@xai-official/grok@1.0.40`（Lody 0.104.0 固定的运行时版本）。

| provider | 账号依赖 | 验证结果 | 状态 |
| --- | --- | --- | --- |
| Kimi | `session/new` 无账号即可（配置虚拟 provider）；真实对话需要模型端点 | 运行时 capability 为 mode `yolo`，**不是** `_permission` 选项（见上表）。`fullAccessSelection` 优先识别 `permission_mode=yolo`，其次 mode `yolo`，两种形态均有 fixture | capability 形态已运行验证；未经真实对话验收。Lody 实际使用的是其分支构建 `2.0.2-lody.*`，此处用的是同版本公开包 |
| Grok | **需要**。适配器 `session/new` 返回 `Authentication required`，唯一认证方式是 `grok.com` 登录 | 无法在隔离环境取得运行时 capability。`permission_mode=always-approve` 仍只来自静态数据 | 仅 fixture 级覆盖，未经运行验证；保持调用者显式选择 |
| DeepSeek Harness | 未检查（需要 `DEEPSEEK_API_KEY` 与 npx 包） | 静态数据 | 仅 fixture 级覆盖 |
| registry | 各 Agent 不同，多数需要账号 | 未验证 | 不做默认；仅调用者显式选择 |

决定(b)保持不变：Kimi 默认 full access，Grok 不默认。因为 Kimi 的运行时形态与静态数据不同，识别规则不再依赖单一形态，这也说明静态依据对其余 provider 的可靠度有限，文档对它们保持“未经运行验证”的标注。

## 风险与备选方案

- **继续白名单，逐个加 provider。** 每个 provider 都要改 Agenvo，违背“不维护 Agent 类型白名单”，也覆盖不了 registry 与 custom。不选。
- **完全不识别，永远要求调用者传 mode。** 与原生一致、最简单，但改变 Codex/Claude 现有行为。折中是保留已有 full-access 默认并扩大到原生认可的标识。
- **按 Lody Role 选择。** Role 是原生预设，会覆盖手工 mode，但依赖云端 Role 目录；随包 README 说明本地 OSS 不启用云端查询。留作后续。
- **把 Grok/Kimi 的 `permission_mode` 折算成 `modeId`。** 不成立：原生只把 category 为 `mode` 的值视为 mode。
- **风险。** 非 Codex provider 只有静态证据；`yolo`/`always-approve` 在运行时可能出现在不同位置；自动批准放宽后可能误批问题类请求。缓解：capability 缺失则不附带权限，请求保持显式，先以隔离 fixture 验证。

## 分阶段实施计划

测试沿用[贡献指南](../CONTRIBUTING.zh-CN.md)：固定运行时、本地模型 mock、临时 HOME/数据目录，不使用个人账号或正在使用的部署。

**阶段 0：运行时调查（无产品改动）。** 在现有 `nativeLody` 系统测试装置中，把 agentConfig 换成 `custom`（`customAcp` 指向仓库内最小 ACP mock，代替需要账号的 provider）和 `builtin/deepseek`（若固定包可离线安装），记录守护进程生成的 `acpCapability` 形态、`modeId`/`configOptionValues` 的接受与拒绝、权限请求的 `_meta` 形态、steer 响应。产出本文“未验证”项的结论。

**阶段 1：解除闸门与显式参数。**
- 去掉 agentType 白名单；full-access 识别改为“内置配置 + capability 中出现原生认可标识”（mode 与 `category:"mode"` 选项），支持 deepseek 的 `danger-full-access`。
- `send`/`steer` 增加可选 `modeId` 与 `configOptionValues`；`appendUserTurn` 支持嵌套 `configOptionValues`。
- 显式 mode/选项时不自动批准；`approvePermissions` 仅在 full-access 策略下运行。
- `modeId`、`modelId`、`configOptionValues` 对照 capability 在写入前同步校验（探测证明守护进程不会代劳）。
- steer 的 `applied:false` 返回原生 `disposition`/`recoveryOwned`，不再统一报告为 unknown。
- 更新 [`docs/lody.md`](../docs/lody.md) 的执行说明与方法描述（沿用 create work context / submit input 术语）。
- 测试：Claude `bypassPermissions` 的云端协议 fixture（补现有空白）；custom mock 与 deepseek 的系统测试；显式 `ask` mode 下权限请求不被自动批准；非法 `modeId` 同步拒绝且不写历史；`yolo` 在 custom 配置下不被当作 full access。

**阶段 2：`_permission` 类选项。** Grok `permission_mode=always-approve`、Kimi `permission_mode=yolo` 的识别与写入，基于阶段 0 的 capability 形态；无法在隔离环境运行真实 provider 的，只做 capability fixture 级覆盖，并在文档标明未经真实执行验收。

**阶段 3：事件流缺口。** 设计见[Lody 事件流设计](lody-events.zh-CN.md)（待确认，未实现）：Lody 已走共享的 `runtime.changed` 路径，`lody.sessions.subscribe` 只是打开文档；方案是补全事件契约并把观察与读取分离。

事件流设计原则（用户已确认）：事件的读者是接收事件的 Agent，不是人类操作员，也不是只转发的 webhook 消费者。判断标准是接收 Agent 能否仅凭事件本身理解发生了什么并决定下一步，即事件携带足够的身份和原生证据（“拿到即可理解并行动”）。

这是[事件设计](events.zh-CN.md)中 Herdr/Codex 的 `runtime.changed` 已确立的跨 Connector 标准：保留原生类型和原生数据，不压平为成功/失败分类；携带原生身份（device/instance/service/thread 与后端 generation）；事件只是唤醒和证据，消费者再读取当前状态与输出，自行判断完成或下一步输入，Agenvo 不预先证明业务成功。

阶段 3 的目标是让 Lody 事件达到同一标准，并以“接收 Agent 能否不靠猜测理解并行动”评估。当前被截断的事件只有 sessionId，没有 turnId、agentConfigId，也没有权限或状态类事件，证据链断裂，接收 Agent 不知道发生了什么、该读什么。设计须保留原生语义，不发明统一的业务结果分类。

## 决定与实现

已决定：非 full-access 配置使用原生缺省并保持权限请求显式；full-access 默认扩展到 Kimi，不扩展到 Grok（Grok 经 `configOptionValues` 显式选择）；阶段 1 纳入 DeepSeek。

阶段 1 实现在 [`workspace.ts`](../apps/lody/src/workspace.ts) 的 `executionConfig`、`fullAccessSelection` 与 `validateSelection`：

- 去掉 agentType 白名单；`create` 只核对配置存在且属于该机器。
- `send`/`steer` 接受 `modeId`、`modelId`、`configOptionValues`，先对照 capability 校验，非法值以 `invalid_params` 拒绝且不写历史；capability 尚未发布时带选择的输入以 `unsupported_capability` 拒绝，不带选择的输入照常执行。
- 未显式选择 mode/选项时，仅 builtin 的 codex（`agent-full-access`/`danger-full-access`）、claude（`bypassPermissions`）、deepseek（`danger-full-access`）、kimi（`permission_mode=yolo`，其次 mode `yolo`）在 capability 声明该设置时默认 full access。capability 缺失则不附带权限设置。
- 自动批准按轮次策略开关：full-access 默认才加入 `controlled`，其他轮次移出，同一 Session 切换策略后立即生效。
- steer 返回 `applied:false` 且 `recoveryOwned` 时，返回 `confirmation: native_steer_requeued` 以及原生 `disposition`；其他未应用结果仍为 unknown。

测试：`tests/lody-agents.test.ts`（协议 fixture：各 provider 的默认与显式选择、校验拒绝、自动批准边界、steer 重新排队）与 `tests/system/lody-agents.test.ts`（固定 `lody@0.104.0` 守护进程 + `tests/support/acp-agent.mjs`，无账号）。真实 DeepSeek、Kimi、Grok 运行时没有在隔离环境中执行；它们的识别依据是随包静态 capability 数据，属于未经运行验收的部分。

推迟到后续阶段：Grok 运行时 capability 验证（需要 grok.com 账号）、DeepSeek 运行时验证；registry 配置的真实运行验证；阶段 3 的事件流缺口（本期未改动事件结构）。

## 当初的待决定

1. 未显式给出权限设置的非 full-access 配置，是否允许用原生缺省继续执行（建议允许，权限请求显式），还是要求调用者必须显式传参。
2. 是否接受“内置认可标识 → 默认 full access”作为现有默认的延伸，并对 Grok/Kimi 同样生效。
3. 阶段 1 是否同时纳入 DeepSeek，还是只做解除闸门与显式参数，仅用 custom mock 验证。
