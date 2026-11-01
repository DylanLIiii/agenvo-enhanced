# Herdr Core Connector

Herdr Connector 附着一个独立运行的 Herdr Core session，不启动或停止 Core。获准实例覆盖该 Core 中所有终端，包括其他客户端创建的终端和 Core 已连接机器上的终端。不同 session 配置为不同实例。端点是 Unix socket 或 Windows 命名管道；自定义端点需显式指定，进入 scope 和 fingerprint。

## 原生契约

接口依据是 [Herdr Core 0.1.15 OpenRPC](https://github.com/herdrdev/herdr-core/blob/v0.1.15/schema/released.openrpc.json) 和 [API 与事件](https://github.com/herdrdev/herdr-core/blob/v0.1.15/schema/README.md)。版本用于复现，不是白名单；握手检查协议 generation 1。使用 plain JSON-RPC，每次调用独立连接，不执行 `hc connect`（它可能启动 Core）。

`terminal.run` 创建终端并运行程序或模板，原样传递执行参数；模板可能发送首条消息，结果的 `first_message` 需要检查。`terminal.list/get/read/send/keys/interrupt/kill/rm/keep/label` 直接使用原生终端地址，`machine.list` 和 `templates.list` 提供发现。`terminal.read` 的 `complete`、`how` 和 `why` 描述快照边界；没有完整会话历史保证。`terminal.send` 默认拒绝 blocked，调用者检查问题后可显式 force。OSC 7501 状态只来自程序；没有报告不等于 idle，done 不等于业务成功。

不暴露 Core 的 `server.stop`、`server.restart`、`machine.add`、`machine.rename`、`machine.rm` 和 `doc.*`：前两者会停掉其他客户端正在运行的共享 Core，中间三个改变实例已批准的访问边界，`doc.*` 是 Core 自己的 KV 存储而非终端工作上下文。

`server.status` 提供 Core 的原生身份、版本、pid、uptime、holder 和终端计数，供调用者判断共享 Core 的状态。`machine.connect` 只对已注册机器立即发起拨号，不新增或修改机器配置；原生拨号最多等待 30 秒，超出 Relay 单次调用期限时本次调用返回 unknown，调用者应以 `machine.list` 的当前状态为准。

`machine.exec` 在没有终端的情况下运行一个程序，原样转发 `argv`/`line`、`cwd`、`env`、`input`、`on` 和 `timeout`；返回原生退出码与 base64 编码的 stdout/stderr，非零退出和超时都是结果而不是错误。它不是 work context：没有终端地址、屏幕或事件。Core 在调用方离开时结束该进程及其子进程，而 Connector 的 socket 等待是 8.5 秒，因此更长的调用返回 unknown，进程同时被 Core 结束，不会继续在后台运行。需要长时间运行的工作应通过 `terminal.run` 建立终端。

`file.read/write/edit` 转发原生 `path`、`cwd`、`on` 和 `offset`/`limit`/`data`/`edits`。原生上限是 8 MB，但 Agenvo 的连接帧是 64 KB：`file.write` 的 base64 数据在 schema 中限制为 45000 字符（约 33 KB 文件），超出的读取由 `bounded` 转换为 `result_too_large`。这些限制来自 Agenvo 传输，不是 Core 行为，描述中明确说明，避免调用者按原生上限规划。`file.edit` 要求每个 `old` 在原文件中恰好出现一次且编辑不重叠，全部成功或全部不写。

原生响应和单条订阅消息的解析上限为 16 MiB，与 Core framed 消息上限一致；订阅初始快照包含全部匹配终端，不能套用 Agenvo 的 64 KiB 返回帧上限。成功解析后的调用结果仍由 `bounded` 限制；超过解析上限的响应返回 `result_too_large`，只读调用标为 rejected，写入调用保留 unknown，避免暗示写入未执行。

`events.subscribe` 的快照用于建立观察；通知转发原生 type、seq 和 terminal 地址。订阅中断时发送一次 `agenvo.resync_required`，持续失败按 1、2、4 秒退避，最多 30 秒，恢复后重置；重连成功或 `missed` 时也要求调用者重新读取，不承诺断线期间事件重放。实例可用性以 `hello` 是否成功为准，订阅故障不阻断健康的 RPC；每次握手更新版本，并同步到 Relay 和本地状态。不转发 heartbeat。当前 `serviceId` 为 `default`，终端地址为 `threadId`。

## 验证

`tests/system/herdr-events.test.ts` 使用隔离 Core 和 OSC 7501 fixture，经真实 MCP 验证外部终端发现、新终端创建、问题读取、blocked 拒绝及显式回答、状态事件，以及 Connector 和 Core 重启后继续交互。平台测试使用固定版本；不使用个人凭据或会话。
