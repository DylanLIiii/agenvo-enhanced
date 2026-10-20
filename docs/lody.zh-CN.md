# Lody 云端与本地连接

[English](lody.md) · [安装](installation.zh-CN.md) · [管理接口](management.zh-CN.md)

`agenvo-lody` 支持云端 workspace 和本机 daemon 两种连接。同一个 Connector 可以配置两种实例；每个实例固定连接路径，不自动切换或重发输入。Agent 仍由 Lody 执行；Connector 只附着已有服务，不安装、启动或停止 Lody daemon。

配置完成后，根据已知环境和用户要求[补充实例上下文](usage.zh-CN.md#补充实例上下文)，让调用方在发现时了解该实例的工作约定与其他有用信息。

## 云端配置与配对

从 Lody 的 Account 设置获取 CLI token，保存到私有文件。文件只包含 token；Unix 使用 0600 权限，Windows 使用仅当前用户可访问的 ACL。使用 Lody 的 workspace ID，不使用显示名称或 URL slug。

```sh
agenvo-lody instance add --id lody-cloud --mode cloud --workspace-id WORKSPACE_ID --token-file /absolute/path/to/lody-token
agenvo-lody connect https://relay.example.com --name cloud-lody
agenvo-lody doctor
agenvo-lody run
```

默认配置目录为 `~/.config/agenvo/lody`。添加实例时验证 token 与 workspace，并记录账号 ID。配置仅保存 token 文件路径，不保存 token 内容。一个实例暴露一个 workspace，包括其他客户端创建的可访问 Session。原始 CLI token 可能拥有更广的账号权限，应保护该文件。变更账号或 workspace 需要重新发现并批准 Agenvo 实例范围；同账号轮换 token 后，Connector 自动读取新文件内容。

默认连接官方云端，可用 `--auth-url` 和 `--auth-site-url` 选择其他 HTTPS 部署。Streams gateway 和分片配置来自云端令牌响应。设备配对和 MCP 客户端授权遵循[使用指南](usage.zh-CN.md)。

`doctor` 检查认证与云端同步。执行还要求调用者有权使用目标机器及项目，并且机器在线。

## 本地附着

先由 Lody 启动本机 daemon。OSS 默认目录为 `~/.lody-oss`，云端版默认目录为 `~/.lody`；自定义安装传入 `--data-dir`。Connector 读取 daemon 的运行文件和目录身份，使用 Unix socket 或 Windows named pipe，不读取或写入其私有数据库。

```sh
agenvo-lody instance add --id lody-local --mode local --platform local
# 附着云端版在本机运行的 daemon：
agenvo-lody instance add --id lody-on-this-machine --mode local --platform cloud --workspace-id WORKSPACE_ID
agenvo-lody doctor
```

本地实例只管理所连接机器的 Session。多个 workspace 时必须指定 `--workspace-id`。本地模式不接收 CLI token；OSS 使用持久的 `local:` 用户身份与 `lw_` workspace。安装身份变化后需要重新发现和授权。Agenvo Relay 的设备配对与客户端授权仍然适用。

`--platform` 选择要附着的安装类型，不会改变 Lody 的构建模式。npm `lody@0.104.0` 是编译固定的云端版，不能靠 `LODY_PLATFORM=local` 将其变为 OSS。使用已启动的 Lody OSS daemon，或用 `--platform cloud` 附着已登录的云端版。

本地连接不调用 Lody 云端接口。OSS 无需 Lody 云端账号；云端版 daemon 自身仍按其原生规则同步和授权。模型服务及 Agenvo Relay 是否需要网络取决于各自配置。

## 发现、创建和使用 Session

通过 `search` 发现实例及原生方法，再通过 `execute` 中的 `call(target, method, params)` 调用。`lody.sessions.list` 返回已有 Session，身份为原生 `id`；`lody.sessions.get` 读取同步元数据，`lody.sessions.live` 通过云端 RPC，或本地 invocation RPC 与 presence 采样实时状态。持久状态不能证明当前是否正在执行，也不能证明任务成功。

先无参数调用 `lody.catalog` 发现机器，再传入 `machineId` 发现该机器的 Agent 配置、能力和项目。结果不包含 provider 配置中的秘密。在 `execute` 中创建 Session：

```javascript
const target = { deviceId: "DEVICE_ID", instanceId: "INSTANCE_ID" };
return await call(target, "lody.sessions.create", {
  machineId: "MACHINE_ID",
  agentConfigId: "AGENT_CONFIG_ID",
  title: "Lody task"
});
```

调用 Outcome 包含 `result.session.id`。创建只写入 Session 元数据，不发送提示词。可选的原生 `project` 用于选择 GitHub 仓库及分支，或执行机器上登记的项目。上下文创建成功不证明 provider 能够成功执行；空 Session 仍遵循 Lody 的原生生命周期。

`lody.sessions.send` 接受 `sessionId`、`text`，以及可选的 `modelId`、`modeId` 和 `configOptionValues`。`lody.catalog` 列出的任何 Agent 配置都可使用，包括 builtin、registry 和 custom ACP Agent。Agenvo 在写入前，按 Lody 为该配置发布的 capability（`modes`、`models`、`configOptions`）校验这些选择，因为原生守护进程不会校验用户轮次的选择，而是原样转给 Agent。若 Lody 尚未探测该配置（创建后到 Agent 首次运行前的数秒内），带选择的输入会以 `unsupported_capability` 拒绝；请省略选择或稍后重试。

未传 `modeId` 或 `configOptionValues` 时，声明了对应设置的 builtin Codex（`agent-full-access`）、Claude（`bypassPermissions`）、DeepSeek Harness（`danger-full-access`）和 Kimi（mode `yolo`，或 `permission_mode` 选项 `yolo`）配置以 full access 运行，普通执行权限自动批准。其他配置（包括 Grok、registry 和 custom Agent）使用原生默认设置，权限请求保持为显式交互。Kimi 的 capability 形态已在无账号的 Kimi Code 运行时核对；DeepSeek、Grok 和 registry 配置依据随包静态数据识别，未经运行验证（Grok 需要 grok.com 登录）。要让 Grok 无人值守运行，传入 `configOptionValues: { "permission_mode": "always-approve" }`；这类显式选择同样会关闭自动批准。忙时输入由 Lody 派发，Agenvo 不增加队列，也不自动重发输入。

`cloud_input_synced` 表示历史和派发标记已到达云端，不代表机器已经开始执行或任务成功。写入后超时返回 `unknown`，原生身份保留在 `error.native` 中；重新输入前应检查 Session。`local_input_received` 表示 daemon 返回的版本向量已覆盖写入，不承诺磁盘持久化、云端上传或执行完成。Connector 在内存保留协议副本，重启后从连接的服务重建；未确认写入没有 Connector 侧的恢复保证。

## 读取、观察和控制

- `lody.sessions.history` 分页读取原生历史。过大的轮次保留身份与结果字段，标记 `truncated: true`；通过 `lody.sessions.turn` 读取完整内容的 JSON 文本片段。继续读取时将返回的 `hash` 作为 `expectedHash`，并传入 `nextOffset`，以检测并发修改。
- 观察不需要调用。Connector 对整个连接监视 Session 元数据，并为原生状态为 `initializing`、`running`、`requestPermission`（或有待回答的用户问题、正在处理的用户 turn）的 Session 打开历史，使它们的 `history.updated` 事件自行送达。Session 回到空闲后保留一段宽限期（30 秒），让最后一个 turn 到达，然后释放。`lody.sessions.history`、`lody.sessions.turn`、`lody.interactions.list` 的读取只在调用期间租用文档；空闲文档按最近最少使用淘汰，所以读取不会永久占用 128 个文档名额。同时最多打开 128 个 Session 文档；若名额全部被活跃 Session 占用，无法被观察的 Session 会通过 `agenvo.resync_required`（`reason: "observation_capacity"`、`scope: "session"`、`sessionId`）报告，对它的读取返回 `resource_exhausted`，直到其他 Session 安静下来。首次历史同步不是完成事件。不提供观察日志；断线后 Connector 自动重新观察活跃 Session，消费者对关心的 Session 重新读取状态（`lody.sessions.get`、`lody.interactions.list`）。
- **自 0.2.0 起的破坏性变更：移除了 `lody.sessions.subscribe`。** 它只负责打开 Session 文档，现已自动完成。请删除对它的调用，不需要替代调用。MCP 事件订阅（`events/subscribe`、`nativeTypes: ["history.updated"]`、`threadId`）保持不变，也不再需要先调用它。收到 `agenvo.resync_required` 后不要重新订阅；读取受影响 Session 的 `lody.sessions.get` 和 `lody.interactions.list`（`scope: "workspace"` 时读取所有关注的 Session）。调用已移除的方法返回 `unsupported_capability`。
- Lody 事件以 `runtime.changed` 送达 MCP 客户端，使用原生类型：`doc-metadata`（原生 Session 元数据变化，含 `status.type` 与 `awaitingUserSince`）和 `history.updated`（原生 turn）。每个事件在 `native.agenvo` 中追加 `sessionId`、`agentConfigId`、`agentType`、`cliType`、`machineId`、事件涉及 turn 时的 `turnId`，以及 `permissionHandling`（`auto_approve_plain`、`explicit`；本 Connector 未选择策略时为 `unknown`）。用 `agentConfigId` 配合 `lody.catalog` 解读 provider 特有的 turn 形态。超过 24 KB 的原生数据缩减为身份加 `truncated`、`omittedBytes` 和 `agenvo.read`；`agenvo.read` 给出读取完整状态的方法和标识（`lody.sessions.turn` 或 `lody.sessions.get`）。`agenvo.resync_required` 带 `scope`：断线后为 `workspace`，只有单个 Session 失去连续性时为 `session` 并带 `sessionId`，只需重读该 Session。云端模式的元数据事件覆盖整个授权工作区，与 `lody.sessions.list` 一致；本地模式只报告所连接的机器。
- `lody.interactions.list` 返回待回应原生请求、`sessionId`、`turnId`、`requestId` 和 response schema。`lody.interactions.respond` 使用这些原生标识及 `outcome` 回应。已受控 Session 的普通执行审批自动允许；用户问题和未知元数据保留显式回应。同步确认不证明 provider 已消费回应，也不证明赢得并发竞争。
- `lody.sessions.cancel` 要求显式 `sessionId` 和 `turnId`，仅取消该轮次一次。本地活跃轮次的 ID 从 `lody.sessions.live` 读取；云端通过 `lody.sessions.history` 获取未结束的 assistant 轮次。拒绝或超时后不会自动重选目标。
- `lody.sessions.steer` 要求 `expectedTurnId`，并接受与 send 相同的可选选择。若 provider 不能 steer，Lody 会把输入重新排队为后续轮次；结果为 `confirmation: "native_steer_requeued"`，并携带原生 `disposition` 与 `recoveryOwned`。其他不确定结果保持 `unknown`，不重发。
- `lody.sessions.archive/restore` 修改原生归档元数据。归档可能停止执行并释放资源；restore 不承诺恢复 provider。

本连接器适配公开源码中的 Lody 客户端协议。云端协议测试使用真实隔离的 Loro Streams 服务，账号与执行端为 fixture；生产云端账号仍未验收。本地系统测试使用 Lody 0.104.0 的原生 daemon/ACP、真实 Codex 和隔离模型，覆盖 Relay MCP 调用及断线恢复；测试组装仅将发布 bundle 的平台选择常量改为 OSS，未修改协议或执行代码。
