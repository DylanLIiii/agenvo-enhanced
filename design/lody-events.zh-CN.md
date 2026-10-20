# Lody 事件流设计

本文是[Lody Agent 选择](lody-agent-selection.zh-CN.md)阶段 3 的设计，状态：**用户已确认，按阶段实现中**。它在[原生事件驱动的观察](events.zh-CN.md)已确立的跨 Connector 标准上，回答 Lody 事件如何让接收事件的 Agent 做到“拿到即可理解并行动”。

## 结论

1. **Lody 本来就走共享的 `runtime.changed` 路径，不存在需要“迁移”的独立事件通道。** `lody.sessions.subscribe` 不发事件，它只是打开一个 Session 文档（见下文证据）。阶段 3 的起点假设需要更正：工作量是补全事件契约和订阅生命周期，不是换通道。
2. **选择方向 (a)：留在共享路径，补全契约与生命周期。** 不建立 Lody 专用事件流。
3. **订阅（观察）与读取分离**：观察由 Connector 根据原生 Session 状态自动管理，调用者不再需要为了收事件而调用 `lody.sessions.subscribe`。
4. 事件保留原生类型和数据，仅在 `native.agenvo` 命名空间内追加身份与读取目标；截断事件保留确定的读取目标；新增一类派生事件 `lody.interaction.pending` / `lody.interaction.resolved`，只为让 Relay 能按原生类型过滤“需要输入”。

需要用户在实现前决定的事项见[决定记录](#决定记录)。

## 现状与证据

### 共享事件基础设施

端到端路径（均为当前 main 的代码）：

```diagram
┌──────────────┐ watchEvents(emit) ┌────────────────────┐ runtime_event ┌──────────────────────┐
│ Adapter      │──────────────────▶│ connectRelay       │──────────────▶│ Relay core           │
│ Herdr/Codex/ │   RuntimeEvent    │ 不知道订阅，不过滤 │   WebSocket   │ 校验指纹/批准/≤64KB  │
│ Lody ...     │                   └────────────────────┘               └──────────┬───────────┘
└──────────────┘                                                                   │ Events.receive
                                                                        ┌──────────▼───────────┐
                                                                        │ 按订阅过滤、入队、   │
                                                                        │ 签名 webhook、重试   │
                                                                        └──────────────────────┘
```

- **协议**：[`packages/protocol/src/events.ts`](../packages/protocol/src/events.ts) 定义唯一事件 `runtime.changed`。过滤条件只有 `deviceId`、`instanceId`、`serviceId`、`threadId`、`nativeTypes`；事件体是严格对象 `{eventId, timestamp, serviceId, threadId?, generation?, nativeType, native}`，不接受额外顶层字段，所以任何新增信息只能进入 `native`。
- **Connector 侧**：[`connection.ts`](../packages/connector/src/connection.ts) 对每个 Adapter 调用可选的 `watchEvents(emit)`，把事件包成 `runtime_event` 发给 Relay。Connector 不知道谁订阅了什么，也不做过滤；非 `online` 状态下事件直接丢弃。重新连接 Relay 时对每个实例发一次 `agenvo.resync_required`（`connector_connected`）。
- **Relay 侧**：[`core.ts`](../packages/relay/src/core.ts#L361) 丢弃帧超过 64KB、指纹未批准或不符合 schema 的事件；[`events.ts`](../packages/relay/src/events.ts) 的 `receive` 按 `deviceId/instanceId/serviceId/threadId/nativeTypes` 匹配订阅，**`agenvo.resync_required` 绕过 `threadId` 与 `nativeTypes` 过滤**；每个订阅积压上限 64 条，超出则清空并改投一条 `delivery_capacity` 重同步；全局 256 条；投递最多 5 次，指数退避，同一 `eventId` 重试；订阅 TTL 默认一天、最长七天。无历史重放，`cursor` 恒为 null。
- **Connector 要发布事件需要做的事**：实现 `Adapter.watchEvents`，构造符合 `runtimeEvent` 的事件，原生数据控制在帧限制内，并在观察中断时发 `agenvo.resync_required`。Herdr（[`herdr-events.ts`](../apps/herdr/src/herdr-events.ts)）转发 `pane.*` 原生事件并按 24KB 截断；Codex（[`codex.ts`](../apps/codex-app-server/src/codex.ts#L224)）只转发白名单内的原生通知，如 `item/tool/requestUserInput`、`serverRequest/resolved`、`turn/completed`，断线时发重同步。

### Lody 当前路径

[`LodyAdapter.watchEvents`](../apps/lody/src/lody.ts#L391) 就是共享接口的实现，不是旁路。事件有两个来源：

| 来源 | 位置 | nativeType | 是否需要打开文档 |
| --- | --- | --- | --- |
| `repo.watch`：meta 房间中所有 `session-*` 文档的元数据变化 | [`workspace.ts:197`](../apps/lody/src/workspace.ts#L197) | `doc-metadata`、`doc-existence-changed`（loro-repo 原生事件名，原样透传 `{kind, docId, patch, by}`） | 否 |
| `doc.subscribe`：已打开 Session 文档的 `history` 变化 | [`workspace.ts:477`](../apps/lody/src/workspace.ts#L477) | `history.updated`（Agenvo 命名），`native = {turn}` | **是** |

`lody.sessions.subscribe` 的实现只是 `await this.connected().document(sessionId)`（[`lody.ts:194`](../apps/lody/src/lody.ts#L194)），即“打开文档”。因此它既不是共享路径的偏离，也不是独立事件流，而是文档同步模型的副作用：只有打开的文档才会产生 `history.updated`，而 `history`、`turn`、`interactions`、`send`、`respond` 也都经过同一个 `document()`。结论：这是文档同步设计的副产物，不是有意的事件设计；没有文档或代码注释说明它是刻意偏离，只有“重连后需要重新订阅”这一使用约束被写进了方法描述。

### 运行证据

在隔离环境中用固定的 `lody@0.104.0` 守护进程（`tests/support/lody-native.ts` 的 OSS 平台常量装配）和 `tests/support/acp-agent.mjs` 自定义 ACP Agent 运行，直接记录 `LodyAdapter.watchEvents` 收到的事件。场景：创建 Session，发送 `NEEDS_PERMISSION`，等待权限请求，约 1.5 秒后经 `lody.interactions.respond` 批准。**全程没有调用 `lody.sessions.subscribe`**（探测脚本是临时文件，已删除，不属于交付）。时间线（毫秒，省略重复字段）：

| ms | nativeType | `by` | 关键内容 |
| --- | --- | --- | --- |
| 18 | `doc-metadata` | — | 创建时的完整元数据，含 `agentConfigId`、`cliType`、`agentType`、`status: idle` |
| 75 | `doc-metadata` | `local` | `latestUserMsgId`、`lastMessageAt`：自己写入的回声 |
| 140 | `doc-metadata` | `live` | `status: initializing`、`processingUserMsgId` |
| 168 | `history.updated` ×2 | — | 用户 turn（`processing`）、助手 turn 出现 |
| 271 | `doc-metadata` | `live` | `status: running`、`acpSessionId` |
| 303–304 | `history.updated`、`doc-metadata` | — / `live` | 助手 turn 内出现 `permissionRequest`；元数据 `status: requestPermission`、`awaitingUserSince` |
| 317 | `doc-metadata` | `live` | 生成的 `title` |
| 1851–1855 | `doc-metadata`、`history.updated` | `live` | `status: idle`、`awaitingUserSince: null`；助手 turn `finished: true` |
| 2027–2028 | `doc-metadata`、`history.updated` | `live` | `processingUserMsgId: null`、`lastHandledUserMsgId`；用户 turn `handled` |

注意：`history.updated` 出现是因为 `send` 已经打开了这个文档。一个只被外部创建、从未被本 Connector 读取过的 Session，只会产生 `doc-metadata`。

起点缺口逐条核对：

| 起点缺口 | 核对结果 |
| --- | --- |
| Session 状态/元数据没有 Lody 事件 | **不成立**。`doc-metadata` 已携带 `status.type`（`initializing`/`running`/`requestPermission`/`idle`）和 `awaitingUserSince`，无需打开文档。真实缺口是：事件没有 Agenvo 身份说明；一轮短任务约有 10 条元数据事件；`nativeTypes` 无法表达“只要需要输入”。 |
| 待处理的权限/交互没有事件 | **部分成立**。`status: requestPermission` 与带 `permissionRequest` 的 `history.updated` 都是原生证据，但前者没有 `turnId`/`requestId`，后者要求文档已打开，且 Relay 无法按它过滤。 |
| 超过 24KB 的事件被替换成 `{sessionId, truncated, omittedBytes}` | **成立**（[`lody.ts:407`](../apps/lody/src/lody.ts#L410)）。`history.updated` 丢掉了 `turn.id`；`doc-metadata` 丢掉了 `patch.status`。同一文件里 `history()` 读取已有保留身份的截断形态（`id/role/status/finished/endedAt/truncated/omittedBytes`），事件没有沿用。 |
| 事件没有 `agentConfigId` | **成立**。只有创建那条 `doc-metadata` 带 `agentConfigId`；后续 patch 与 `history.updated` 都没有。 |
| 读取永久占用 128 个文档名额 | **成立**。`docs` 只在打开失败时删除（[`workspace.ts:458`](../apps/lody/src/workspace.ts#L458)），没有引用计数和驱逐；读历史、读交互、发送都会占用名额。 |
| 断线后重订阅 + 重读 | **成立**。`onDisconnect` 废弃整个 workspace 并发一次全局 `agenvo.resync_required`（[`lody.ts:248`](../apps/lody/src/lody.ts#L248)）；新 workspace 的 `docs` 为空。 |
| 结构性变更只回放最后 50 条 | **成立**，而且 `onGap` 不带 Session 参数，任何一个 Session 的缺口都表现为全局重同步（[`workspace.ts:489`](../apps/lody/src/workspace.ts#L489)）。 |

另外两个影响事件含义的发现：

- **云端模式下 `repo.watch` 不按机器过滤**（[`workspace.ts:213`](../apps/lody/src/workspace.ts#L213)），事件覆盖授权工作区内所有 Session，本地模式则按 `machineId` 过滤。范围与 `lody.sessions.list` 一致，但文档没有说明事件范围。
- **自动批准的 `controlled` 集合只在进程内存里，且只在 `doc.subscribe` 回调里触发**（[`workspace.ts:503`](../apps/lody/src/workspace.ts#L503)）。重连后 workspace 重建，集合清空，已有 Session 的权限请求既不会被自动批准，也没有任何事件说明这一点。

### 心跳测量

阶段 1 用 `tests/support/acp-agent.mjs` 的 `LONG_RUN<ms>`（运行期间每 2 秒输出一块内容）在固定 `lody@0.104.0` 守护进程上记录 `LodyAdapter.watchEvents` 的事件：

| 运行 | 时长 | `doc-metadata` 事件 | 只含 `lastRunningSeen` 的 patch | `history.updated` |
| --- | --- | --- | --- | --- |
| 60 秒，无输出 | 60 秒 | 开始 4 条、结束 3 条，中间 0 条 | 0 | 开始 3 条、结束 2 条，中间 0 条 |
| 30 秒，每 2 秒一块输出 | 30 秒 | 开始 4 条、2.3 秒时 1 条（`lastModel`）、结束 3 条，其余 0 条 | 0 | 开始 3 条、2.3 秒时 1 条、结束 2 条，其余 0 条 |

`lastRunningSeen` 只在 `status` 变化时随 patch 一起出现，运行期间守护进程没有周期性心跳 patch；守护进程对历史文档按较粗的批次写入，所以流式输出并不会让 `history.updated` 与输出块一一对应。结论：不丢弃也不合并 `doc-metadata`，保持原生语义。这是本地守护进程加 mock Agent 的结果；真实 provider 和云端模式没有测量，若后续在真实运行中发现心跳型 patch，再按“仅 `lastRunningSeen` 的 patch 不发”追加规则。

## 方向选择

### (a) 留在共享路径，补全契约（选择）

- **Relay 耦合**：Relay 的订阅、签名投递、重试、权限检查和队列容量全部按 `deviceId/instanceId/serviceId/threadId/nativeTypes` 建立，Lody 已是同一接口的使用者。专用流必须同时新增 MCP 事件定义、订阅生命周期和投递，而这些在 Relay 内已有并被测试覆盖。
- **ChatGPT/MCP 事件客户端**：客户端只看到 `events/list` 里的 `runtime.changed`。专用流要求客户端学习第二种事件，而 ChatGPT Events 是扩展草案，不应增加协议面。
- **原生类型过滤**：`nativeTypes` 已能区分 `history.updated` 与 `doc-metadata`，加上派生类型就能表达“需要输入时唤醒我”。
- **云端/本地文档模型**：Loro 文档同步没有跨文档序号，无法提供事件重放日志；[Lody Connector 设计](lody-connector.zh-CN.md)已决定“不维护第二套观察日志”。共享路径“事件即唤醒+证据，重连后重读状态”正好匹配这一模型。

### (b) Lody 专用流（不选）

保留 `lody.sessions.subscribe` 为事件源，并升级为带游标的流或 Lody 自己的事件日志。拒绝原因：

- 要么复制 Relay 的订阅、投递与权限，要么让 MCP 客户端轮询，两者都违背“不另建调度系统”。
- 事件日志需要持久化和跨文档排序，Loro 文档模型不提供；等于引入 Agenvo 自己的事件数据库，违背 [events.zh-CN.md](events.zh-CN.md) 的决定。
- 并不解决真正的缺口：缺口在事件内容和文档生命周期，不在通道。

## 事件契约

原则：事件的读者是接收 Agent；保留原生类型和数据，不压平成成功/失败；携带原生身份；事件只是唤醒和证据。Lody 的“原生”包含 loro-repo 事件名（`doc-metadata`）、Lody 历史 turn 和 ACP 权限请求。

### 事件类型

| nativeType | 来源 | 何时发出 | 说明 |
| --- | --- | --- | --- |
| `doc-metadata` | 原生（loro-repo） | Session 元数据变化 | 保留 `{kind, docId, patch, by}`，不丢弃任何 patch。阶段 1 的测量没有发现只含 `lastRunningSeen` 的 patch，见[心跳测量](#心跳测量)。 |
| `doc-existence-changed` | 原生 | Session 创建、删除、恢复 | 原样。 |
| `history.updated` | Agenvo 命名，原生 turn | 被观察 Session 的历史变化 | `native = {turn}`，turn 为原生 turn。 |
| `lody.interaction.pending` | 派生自原生待处理权限请求 | 出现不会被自动批准的 `permissionRequest` | `native = {turnId, requestId, toolCallId, title, permissionRequest}`；每个请求只发一次，也包括自动批准写入失败后的请求。 |
| `lody.interaction.resolved` | 派生自原生 `permissionRequest.outcome` | 请求获得结果，或其所在 turn 在没有结果的情况下结束 | `native = {turnId, requestId, outcome?, resolvedBy?}`；`resolvedBy` 只在本 Connector 写入时出现（`agenvo_respond`、`agenvo_auto_approve`）。 |
| `agenvo.resync_required` | Agenvo | 观察中断 | 增加范围信息，见生命周期。 |

不新增 Agenvo 自己的 `status.changed`：状态转换已是原生 `doc-metadata`，消费者读取 `patch.status.type`。也不新增“turn 完成”类型：完成是 `history.updated` 中 `turn.finished: true`；失败、取消、完成都会 finished，含义由消费者判断，遵守“不为统一接口强行转换成结构化结论”。

“需要输入”是例外，原因：Relay 只能按 `nativeTypes` 和 `threadId` 过滤。没有独立类型时，只想在需要输入时被唤醒的订阅必须接收全部 `doc-metadata`，每次状态变化都唤醒一次 Agent。派生事件不判断业务结果，只把“存在一个无人响应的原生请求”这一原生事实变成可过滤的类型。若用户不接受新增类型，替代方案是只靠 `doc-metadata`（见[决定记录](#决定记录) 2，已选择新增）。

### 身份：`native.agenvo`

事件体顶层不能扩展，所以身份放在 `native.agenvo`。这个键不与任何原生字段重叠，原生数据保持原样：

```json
{
  "agenvo": {
    "sessionId": "…",
    "agentConfigId": "…",
    "agentType": "codex",
    "cliType": "builtin",
    "machineId": "…",
    "turnId": "…",
    "permissionHandling": "auto_approve_plain | explicit | unknown"
  }
}
```

- `sessionId` 与信封 `threadId` 相同，重复出现是为了截断和转发后仍自描述。
- `agentConfigId`/`agentType`/`cliType`/`machineId` 来自缓存的 Session 元数据（创建时写入，一般不变）。消费者据此知道如何解读 provider 特有的 turn 形态，并去 `lody.catalog` 读取该配置的 capability。元数据缺失时省略字段，不猜测。
- `turnId` 在 `history.updated`（`turn.id`）、`lody.interaction.*`、以及 patch 含 `processingUserMsgId`/`lastHandledUserMsgId` 时出现，对应 `lody.sessions.turn` 与 `lody.interactions.respond` 的原生标识。
- `permissionHandling` 揭示阶段 1/2 的自动批准边界：`auto_approve_plain` 表示本进程记录该 Session 当前轮次为 full-access 策略；`explicit` 表示调用者显式选择或使用原生缺省，请求会等待处理；`unknown` 表示 Connector 重连或重启后不再知道策略。

### 截断语义

保持 24KB 的原生数据上限（Relay 帧限制 64KB）。超限时：

- `native.agenvo` 完整保留；`truncated: true`、`omittedBytes` 保留。
- `history.updated` 的 `turn` 退化为 `history()` 已用的形态 `{id, role, status, finished, endedAt, truncated: true, omittedBytes}`，并附 `agenvo.read = {method: "lody.sessions.turn", sessionId, turnId}`，读取目标确定。
- `doc-metadata` 的 `patch` 保留 `status`、`awaitingUserSince`、`processingUserMsgId`、`lastHandledUserMsgId`、`isArchived` 等小字段，其余以 `omittedKeys` 列出，读取目标是 `lody.sessions.get`。
- `lody.interaction.pending` 优先保留 `permissionRequest` 的选项与标题，丢弃工具输出等大字段，读取目标是 `lody.interactions.list`。

这会改变现有 `{sessionId, truncated, omittedBytes}` 形态，只影响超过 24KB 的少数事件。

### “需要输入时唤醒我”

订阅 `nativeTypes: ["lody.interaction.pending"]`（可再加 `threadId`）。事件携带 `sessionId`、`turnId`、`requestId`、原生 `permissionRequest`（含选项）与 `agentConfigId`，消费者可直接调用 `lody.interactions.respond`，再读取交互列表确认——Lody 写入不确认 provider 消费，也不保证赢得多客户端竞争。

- **自动批准的请求不发 `pending`**：full-access 轮次里 Connector 批准“明确的普通执行权限”，消费者不需要行动。批准结果通过 `history.updated`（请求的 `outcome`）和 `lody.interaction.resolved`（`resolvedBy: "agenvo_auto_approve"`）留证据。若批准写入失败，请求保持待处理，此时发 `pending`。
- **重连后的 Session**：`controlled` 丢失，策略为 `unknown`，Connector 不自动批准，请求以 `pending` 发出，由消费者响应。这把现在的“静默停住”变为“可见的待处理”。
- 问题类请求（`_meta` 非空）从不自动批准，总是 `pending`。

## 订阅与读取生命周期

目标：收事件不需要调用任何“订阅”方法；读取不占用观察名额；128 个文档上限继续存在（房间成本），但它限制同时打开的数量，不限制生命周期内读过多少。

两个概念分开：

- **观察（observation）**：由 Connector 根据原生状态决定。元数据始终观察（meta 房间，一个）。历史文档在 Session 活跃时打开：活跃沿用原生 Lody 的分类，即 `status.type` 为 `running`、`requestPermission`、`initializing`，另加 `awaitingUserSince` 非空或 `processingUserMsgId` 为字符串（`isActive`）。`error`/`stopped` 等状态不算活跃，避免长期停留在这些状态的 Session 永久占用名额；连接建立时扫描一次现有活跃 Session。`latestUserMsgId` 变化不作触发条件：发送本身已持有文档，随后的 `initializing` 状态会接管。回到 `idle` 且没有待处理请求后保留一段宽限期（建议 30 秒，供最后的 `finished` turn 到达）再释放。活跃 Session 的 `history.updated` 与自动批准因此不依赖调用者操作，也不依赖“这个 Session 是否碰巧被读过”。
- **读取（lease）**：`history`、`turn`、`interactions`、`respond` 借用文档并在空闲一段时间后归还，使用引用计数和 LRU；文档同时被观察和读取时共享同一份。

容量：先驱逐 LRU 的非活跃读取文档；若 128 个全部是活跃观察，新读取返回 `resource_exhausted`，同时发 `agenvo.resync_required`（`observation_capacity`），告诉订阅者有 Session 因容量未被观察，而不是静默漏掉。这是已有语义的收紧，不新增调度机制。

`lody.sessions.subscribe`：该方法随 0.2.0 发布（引入它的提交 [`6d541b7`](https://github.com/DylanLIiii/agenvo-enhanced/commit/6d541b7) 早于 release 0.2.0 的 `a89415e`），属于已发布外部契约，不是“未发布版本别名”。已确认删除，并作为破坏性变更记录在发行说明和 [`docs/lody.md`](../docs/lody.md)；迁移方式是删除调用，不需要替代调用。删除后，历史事件的开启条件由观察规则覆盖；空闲 Session 没有新事件，变化时观察规则自然打开。

### 重连与重同步

现状：断线 → 丢弃 workspace → 一次全局 `agenvo.resync_required`，新 workspace 无文档。消费者代价：对每个关注的 Session 重新订阅，再读历史、交互、状态。

新设计：

- 断线时仍发全局 `agenvo.resync_required`（`lody_disconnected`/`cloud_disconnected`）。重连并 `caughtUp` 后，Connector 对元数据中仍活跃的 Session 自动重新打开观察，调用者不需要重订阅。
- 重同步事件在 `native` 追加范围：全局断线 `{reason, scope: "workspace"}`；单文档缺口（房间状态非 `joined`、历史结构变更超过 50 条、turn 读取失败）发 `{reason, scope: "session", sessionId, historyLength}`。信封 `threadId` 保持缺省（Relay 对重同步绕过 `threadId` 过滤，写上去会误导）。`onGap` 需要接收 `sessionId`。
- 结构性变更仍回放最后 50 条 `history.updated`；超过 50 条同时发 session 范围的缺口。不改变这个有限窗口。
- 消费者恢复成本：全局重同步后，对关注的 Session 读 `lody.sessions.get`（元数据，含 `status`）和 `lody.interactions.list`，即 O(关注数) 的小读取；只有 `status`/`lastHandledUserMsgId` 表明期间有变化的 Session 才需要读历史。session 范围缺口只需重读该 Session。

仍然存在的一个读取成本：`lody.sessions.history` 的游标只能从头向后翻页（[`lody.ts:292`](../apps/lody/src/lody.ts#L292)），大历史“读尾部”需要 O(N) 翻页。建议增加以已知 `turnId` 之后为起点的读取（`afterTurnId`），否则缺口恢复成本随历史长度增长。这是读取接口增补，列入阶段 4，按决定记录 4 留到阶段 4。

## 与阶段 1/2 语义的交互

| 语义 | 事件必须说明的内容 | 设计 |
| --- | --- | --- |
| 每轮自动批准边界（`controlled`） | 当前轮次是否会被自动批准；重启后不确定 | `agenvo.permissionHandling`；`unknown` 时不自动批准，请求以 `pending` 发出 |
| steer 重新排队 | 原生 steer 未应用，输入作为后续轮次执行；调用结果为 `native_steer_requeued` | 事件靠 turn 身份关联：调用结果返回 `userTurnId`，后续 `history.updated` 的 `turn.id` 相同。阶段 3 的系统测试用 `acp-agent.mjs`（steer 返回 `unsupported`）确认这条 turn 的事件序列确实可关联；若缺少关联线索，再补 `agenvo.userTurnId`，不预先设计 |
| capability 行发布时机 | 带 `modeId`/`modelId`/`configOptionValues` 的输入在 capability 发布前被 `unsupported_capability` 拒绝；发布发生在守护进程首次运行 Agent 之后 | 机器 flock 的 `acpCapability` 当前没有被观察。flock 实现有 `subscribe`，但未在本 Connector 中验证。可选事件 `lody.capability.published`（`agentConfigId`、可选 `modes/models` 标识）放在阶段 4，先用探测确认 flock 事件在本地与云端模式都可用 |

## 现有消费者受到的影响

| 对象 | 变化 |
| --- | --- |
| `events/subscribe` 订阅格式 | 不变。`deviceId/instanceId/serviceId/threadId/nativeTypes` 与 `runtime.changed` 定义不变，Relay 无改动 |
| `nativeTypes: ["history.updated"]` 或 `["doc-metadata"]` 的订阅 | 继续收到同名事件；`native` 追加 `agenvo` 键；`doc-metadata` 少了仅含心跳字段的事件；不再需要先调用订阅。新增类型不会被已有 allowlist 收到 |
| 不带 `nativeTypes` 的订阅 | 额外收到 `lody.interaction.*`，并且不调用订阅也能收到活跃 Session 的 `history.updated` |
| 依赖 `{sessionId, truncated, omittedBytes}` 形态的消费者 | 超 24KB 事件形态改变（见截断语义） |
| `lody.sessions.subscribe` | 已删除（0.2.0 起的破坏性变更）：调用返回 `unsupported_capability`；迁移方式是删除调用，MCP 订阅不变 |
| 断线恢复 | 不再需要重订阅；仍需处理 `agenvo.resync_required`，现带 `scope`/`sessionId` |
| `docs/lody.md`、`docs/events.md` | 实现时更新：事件类型、身份、观察规则与云端事件范围；沿用 `create work context`、`submit input`、`read output` 术语 |

没有 UI 或交互界面变更，不涉及[开发约定](../AGENTS.md)中针对 UI/UX 的设计文档、截图与录屏要求；事件消费者是 Agent。

## 风险

- **心跳事件量**：阶段 1 测量没有发现心跳型 patch（见[心跳测量](#心跳测量)），因此不丢弃也不合并。真实 provider 的流式输出可能产生更多 `history.updated`；这一点未用真实 provider 测量，Relay 每订阅 64 条上限仍会在极端情况下触发 `delivery_capacity` 重同步。
- **派生事件被误读为业务结论**：`pending`/`resolved` 只陈述原生请求状态，文档须写明不代表任务成功或被 provider 消费。
- **观察规则依赖元数据状态**：若 daemon 在某些路径上不更新 `status`，活跃判断会漏；用 `latestUserMsgId` 变化和读取租约兜底。阶段 2 用 mock ACP 覆盖 `running → requestPermission → idle`，云端协议 fixture 覆盖元数据缺失。
- **云端事件范围**：包含工作区内所有 Session 的元数据事件，含其他机器的，与 `list` 范围一致但事件量更大。观察名额只用于活跃 Session，仍可能触顶。
- **自动批准边界**：重连后 `unknown` 使 full-access Session 的权限请求变成需要消费者处理。这比静默停住更安全，但是行为变化，需写入文档。
- **云端协议没有生产验收**：云端部分只有 loro-repo/Loro Streams fixture 证据。

## 分阶段实施计划

所有测试遵循[贡献指南](../CONTRIBUTING.zh-CN.md)：固定 `lody@0.104.0` 守护进程 + `tests/support/acp-agent.mjs`，云端用 Loro CLI 0.6.0 Streams fixture，临时 HOME，不使用个人账号或生产环境。

**阶段 1：事件内容（无生命周期变化）。**
- `native.agenvo` 身份（`sessionId`、`agentConfigId`、`agentType`、`cliType`、`machineId`、`turnId`），截断保留读取目标，`onGap` 携带 `sessionId`，重同步增加 `scope`。
- 测试：协议 fixture（`tests/lody.test.ts` 风格）——超过 24KB 的 turn 事件保留 `turn.id` 与读取目标；`doc-metadata` 截断后仍有 `status`；系统测试（扩展 `tests/system/lody-agents.test.ts`）——`NEEDS_PERMISSION` 流程中每个事件带正确 `agentConfigId` 和 `turnId`，并
- 不改工具面，不动 `lody.sessions.subscribe`，独立于生命周期，先落地。

**阶段 2：观察与读取分离。**
- 活跃集合、租约、驱逐、重连后自动恢复观察；删除 `lody.sessions.subscribe`；`controlled` 与 `permissionHandling`。
- 测试：云端 fixture 创建 130+ 个 Session 逐个读取不触顶；128 个同时活跃时的容量事件与 `resource_exhausted`；daemon 重连后活跃 Session 无需调用订阅即继续收事件；重连后权限请求不再静默停住（`permissionHandling: unknown`）。Relay 集成测试经 webhook 验证事件不依赖订阅调用。

**阶段 3：交互事件与关联证据。**
- `lody.interaction.pending/resolved`、自动批准结果证据、steer requeue 的 turn 关联。
- 测试：mock ACP 的 `NEEDS_PERMISSION` 在显式策略下发 `pending`，在 full-access 下不发 `pending` 但有 `resolved`；问题类（`_meta`）总是 `pending`；Relay 集成测试 `nativeTypes: ["lody.interaction.pending"]` 的 webhook 过滤；steer 返回的 `userTurnId` 能在 `history.updated` 中找到。

**阶段 4（可选，需确认）：** `lody.capability.published`；`lody.sessions.history` 的 `afterTurnId`。测试：flock 订阅探测；大历史尾部读取成本。

## 实现状态与验证

阶段 1–3 已实现（本地提交，未推送）。

| 阶段 | 内容 | 主要代码 | 测试 |
| --- | --- | --- | --- |
| 1 事件内容 | `native.agenvo` 身份；截断保留读取目标；`onGap` 带 `sessionId`，重同步带 `scope`；顺序化发布（元数据查询后再发出，修正了本地模式异步过滤可能乱序） | [`events.ts`](../apps/lody/src/events.ts)、[`workspace.ts`](../apps/lody/src/workspace.ts) | `tests/lody.test.ts`（超大 turn 与元数据截断、重同步 scope）；`tests/system/lody-agents.test.ts`（真实 `lody@0.104.0` 守护进程加 mock ACP：每个事件的 `agentConfigId`/`turnId`） |
| 2 观察与读取分离 | `isActive` 驱动的自动观察、宽限期释放、读取租约与 LRU 驱逐、容量事件、移除 `lody.sessions.subscribe` | `workspace.ts`（`entry`/`use`/`observe`） | `tests/lody-events.test.ts`（无订阅调用即收事件、宽限期释放、重连后恢复观察、130 个 Session 读取不触顶、128 活跃时的 `observation_capacity` 与 `resource_exhausted`） |
| 3 交互事件 | `lody.interaction.pending/resolved`、自动批准结果证据、`permissionHandling: unknown` 的请求不静默停住 | `workspace.ts`（`scan`/`announce`/`resolved`） | `tests/lody-events.test.ts`（重连后宣告、他人回应、超大请求）、`tests/lody-agents.test.ts`（自动批准只有 `resolved`，显式策略与问题类有 `pending`）、`tests/system/lody-agents.test.ts`（真实守护进程的 `pending`/`resolved` 与 steer 的 `userTurnId` 关联）、`tests/integration/lody.test.ts`（Relay webhook 按 `nativeTypes` 过滤） |

实现中与设计不同或新增的细节：

- **不抑制心跳 patch**：见[心跳测量](#心跳测量)。
- **steer 关联**：系统测试确认 requeue 后的用户 turn 在 `history.updated` 中的 `turn.id` 等于调用返回的 `userTurnId`，因此没有新增 `agenvo.userTurnId`。
- **`resolved` 在 turn 无结果结束时也发出**（`outcome` 缺省），因为对消费者而言请求已不再需要处理。
- **`respond` 的本地写入不触发 `history.updated`**（Loro 本地提交事件被跳过），所以 `lody.interaction.resolved` 同时承担这次回应的证据。
- **`pendingInteractions` 先看 turn 的 `finished` 再物化**：每次历史变化都会扫描，避免对大历史做 O(N) 的 JSON 物化。
- **宽限期**：`observation.graceMs`（默认 30 秒）是模块级常量，测试缩短它，不是配置项。
- **本期未做**：`lody.capability.published` 与 `lody.sessions.history` 的 `afterTurnId`（阶段 4，待用户确认）；真实 provider、云端生产环境和 ChatGPT 客户端的验收。
- **已知限制**：长期停留在 `running` 的僵尸 Session（机器崩溃但元数据未更新）会占用观察名额，直到状态改变；128 个这样的 Session 会使新 Session 无法观察并触发 `observation_capacity` 事件。

## 决定记录

1. **`lody.sessions.subscribe` 的处理。** 已决定：删除（选项 A），标注破坏性变更。
2. **是否新增派生事件 `lody.interaction.pending/resolved`。** 已决定：新增，因为 Relay 只能按原生类型过滤；替代方案是只用 `doc-metadata`，消费者自己过滤，代价是每次状态变化都唤醒一次。
3. **身份放在 `native.agenvo` 还是扩展 `runtimeEvent` 顶层。** 已决定：前者（不改共享协议，不影响 Herdr/Codex）；后者能让所有 Connector 受益，但改变 Relay 与 SDK 契约。
4. **`lody.sessions.history` 的 `afterTurnId`**：留到阶段 4，阶段 1–3 不需要它。
5. **心跳 patch 的抑制规则**：已由阶段 1 实测决定，不抑制，见[心跳测量](#心跳测量)。
