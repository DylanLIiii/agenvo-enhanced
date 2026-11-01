# 使用 Agent 原生能力

[English](management.md) · [使用说明](usage.zh-CN.md)

Agenvo 只提供 `search` 和 `execute` 两个 MCP 工具。search 接受关键词，execute 接受 JavaScript 函数体。先发现目标及准确的方法 schema，再组合原生调用。Thread 是工作上下文，Agenvo 不另建 Thread 或 Turn 模型。

## 发现

先向 search 传入空查询，列出获准实例及在线状态，不加载方法目录：

```json
{"query": ""}
```

先按操作浏览方法摘要，再限制目标并获取所需方法的完整 schema：

```json
{"query": "submit input"}
```

```json
{"query": "thread/start", "deviceId": "DEVICE_ID", "instanceId": "coding", "includeSchema": true}
```

响应的 result.items 包含实例及匹配的 methods，默认每个方法只包含 name、description 和 readOnly。需要参数定义时，限定目标和方法名并传入 includeSchema: true，获取完整 inputSchema。省略 includeSchema 或传入 false 均返回摘要；描述原样保留，不截断调用约束。空查询即使传入 true 也只列实例。query 不区分大小写，按空白拆分关键词，所有词都需要出现在 Connector 类型、方法名或描述中。不执行代码，不使用正则或语义搜索。搜索 codex 或 herdr 可以列出该类型的全部方法；deviceId 和 instanceId 用于限定目标。

deviceId 标识一个 Connector，不是一台物理机器。离线或无法查询的实例仍返回状态或错误；方法查询失败可能留下部分结果。没有匹配方法的在线实例不出现在非空查询结果中。名称在实例内唯一，不添加 Agenvo 命名空间。

两种 Connector 使用共同的操作词：list、create、read、submit input、interrupt、respond。work context 在 Codex 中是 conversation thread，在 Herdr Core 中是运行 Agent 的 terminal；Herdr Core session 是独立运行的服务。原生方法名和字段名保留，不把不同对象强行等同。

发现结果还会原样携带配置者提供的可选 `context` 自由文本。选择和使用实例时先阅读它；空查询、匹配方法的查询和离线实例均可包含最近通告。上下文不参与方法关键词匹配，不是实时能力或权限保证，也不会自动传入原生调用。配置方式见[实例上下文](usage.zh-CN.md#补充实例上下文)。

搜索也可能在 `result.updates` 提示所选获准范围内 server 和 Connector 的更新正式版本。这是 Agenvo 发行信息，不是原生运行时更新或兼容性保证。按[更新指南](updating.zh-CN.md)判断并使用已有工具执行；没有提示不证明安装版本已经是最新。

## 执行

### Paseo 终端与项目

发现 `paseo.terminals` 可在已有 workspace 创建普通 shell、列出终端、执行命令、
捕获输出、输入文字或按键、关闭终端，无需启动 Agent。保留返回的原生 terminal ID。
`run` 附加回车，`send-text` 不附加任何内容。输入确认仅表示传输提交；Paseo 不确认
终端输入已收到，也不报告命令退出码。Connector 不自动重放输入。结果不确定时，
读取输出，并根据操作本身判断是否适合重试。

`read` 保留 Paseo 原生 capture 的 `start`/`end` 偏移。输出超过中继限制时缩小范围。
`send-keys` 接受 Paseo 的按键描述，例如 `{key: "Enter"}` 或 `{key: "c", ctrl: true}`。
默认使用原生编码器的普通模式。需要时通过可选 `inputMode` 覆盖：application cursor
模式使用 `{applicationCursorKeys: true}`，组合 Enter 使用程序的 `kittyKeyboardFlags` /
`win32InputMode`。省略的字段采用普通模式的值。Connector 不检测目标程序的输入模式。
不支持的按键会在发送任何输入前拒绝整个批次。

将克隆后的目录注册到 Paseo 项目列表时，发现 `paseo.projects.add` 并传入 `cwd`，
再通过 `paseo.projects.list` 验证。创建 workspace 与注册项目是不同操作，均不会 clone 仓库。

把下面的函数体传给 `execute`，将目标替换为发现的 ID：

```js
const target = {deviceId: "DEVICE_ID", instanceId: "coding"};
const created = await call(target, "thread/start", {});
if (created.error) return created;
const threadId = created.result.thread.id;
const sent = await call(target, "turn/start", {
  threadId, input: [{type: "text", text: "检查失败的测试。"}]
});
return {threadId, sent};
```

call 返回 `{execution, requestId, result, nativeIds?, error?}`。在代码中检查错误；原生拒绝作为数据返回。调用相互独立，不构成事务。用循环处理分页，只返回相关字段。执行器不提供宿主文件、网络、环境变量或模块导入。脚本总时限 30 秒，并通过计算中断结束死循环；不另设调用次数或脚本结果大小配额。响应前会收集已派发调用的确认，因此收尾最多可能再等待一个原生调用超时。

execute 将字符串原样作为 MCP 文本返回，将其他 JSON 值直接序列化；没有 return 或返回 undefined 时输出 `null`。正常返回不添加结果包装或调用回执。你可以返回完整的 call 结果、筛选后的对象或一段文字；需要执行确认、requestId 或原生 ID 时，在脚本中显式返回它们。原生拒绝作为 call 返回的数据，由脚本检查；正常返回的脚本即使包含原生拒绝，MCP isError 也为 false。

脚本抛错、超时、中断或返回值不能序列化时，MCP isError 为 true。响应包含错误诊断、脚本 requestId，以及已派发调用的确认信息，帮助判断哪些操作已经发生。诊断是供 Agent 阅读的文本，不要求依赖固定 JSON 路径。accepted 只表示提交，不代表业务成功；starting 表示仍在启动。unknown 后先检查原生状态再决定是否重试写入。没有自动重试或回滚。

例如，只返回会话 ID 文本：

```js
const r = await call(target, "thread/list", {});
if (r.error) return r;
return r.result.data.map(thread => thread.id).join("\n");
```

每次原生调用沿用现有访问授权。后续调用被拒绝时，先前调用已返回的结果仍可用于判断进展；已发生的工作不会撤销。

### 在调用之间等待

`execute` 不提供 `setTimeout`、`sleep` 等计时器，也不提供阻塞等待任务完成或未来输出的能力。提交输入后返回，由调用方 Agent 决定何时再次读取，并通过自身的等待机制或[事件协议](events.zh-CN.md)在 `execute` 之外等待。不要在脚本内忙等或轮询任务完成。30 秒时限用于保护脚本执行，不是等待任务的预算。

例如，在一次 `execute` 中提交 Herdr 命令，使用发现的目标和 terminal 地址：

```js
return await call(target, "terminal.send", {terminal, text: "echo hi"});
```

检查确认结果并在 Agent 一侧等待后，在另一次 `execute` 中读取输出。脚本变量不会跨调用保留，需要重新定义 `target` 和 `terminal`：

```js
return await call(target, "terminal.read", {terminal, lines: 20});
```

根据输出判断命令是否完成。输出尚未就绪时，在 `execute` 之外等待后再读取。如果脚本在提交输入后失败，先检查错误诊断附带的调用确认和原生状态，再决定是否重复提交。

## Codex

按 schema 使用 thread/list、thread/start、thread/read、thread/resume、thread/archive 和 thread/unarchive。原生列表的 provider/source 过滤决定发现范围，查找其他客户端的会话时应检查这些参数。通过 turn/start 输入，turn/steer 携带 expectedTurnId，turn/interrupt 携带已知 turnId。未加载会话可能需要先 resume。Agenvo 工作入口使用全权限并自动回答权限审批。

`notifications.list({threadId, cursor?, limit?})` 读取当前连接收到的有界通知，不是持久历史或所有会话的完整覆盖。resume 会话以订阅；resume 不重放历史输出。保存 nextCursor，在淘汰或重连后检查 gap。空会话、临时会话及某些原生版本可能不支持历史读取；历史可用时直接读取，通知用于获取已收到的输出。

`requests.list({threadId?, cursor?})` 返回待回答问题和工具调用，包含原生参数与 responseSchema。可以在 execute 中筛选，再通过 `requests.respond({interactionId, result})` 回答。标识绑定当前连接，重复或过期回应失败。提交成功不证明你的回答赢得其他客户端的并发竞争。权限审批自动回答，不进入待回答列表。

## Herdr Core

每个实例连接一个独立运行的 Core session。`terminal.list` 包含其他客户端创建的终端，以及该 Core 已连接机器上的终端；`box/t7` 等地址保留原生含义。`terminal.run` 在新终端启动程序或模板，按需传入 `argv`、`cwd`、`on` 和执行设置。模板可能发送首条消息，需检查 `first_message`。结果未知时先查询终端列表，再决定是否重试。

`terminal.send` 粘贴文本并回车；程序处于 blocked 时会拒绝，除非设置 `force`。回答前先检查问题。`terminal.keys` 发送原生按键，`terminal.interrupt` 发送停止键并报告观察结果；`terminal.kill` 停止程序，`terminal.rm` 删除已结束的记录。关闭 Connector 不会停止 Core 或终端。

`terminal.read` 返回 `text`、`complete`、`how` 和 `why`；`lines` 选择屏幕上方的历史行数。全屏应用工作时可能只能读取屏幕，快照不是持久会话记录。`terminal.get` 只报告程序通过 OSC 7501 主动发送的状态；没有报告的程序没有状态。idle 或 done 也不证明业务成功。使用[事件](events.zh-CN.md)选择读取时机，重同步后重新读取。

```js
const read = await call(target, "terminal.read", {terminal, lines: 80});
if (read.error) return read;
return read.result.text;
```

Lody 通过 `lody.*` 方法暴露原生 Session、历史、精确轮次取消和交互。云端与本地连接边界见 [Lody 指南](lody.zh-CN.md)。
