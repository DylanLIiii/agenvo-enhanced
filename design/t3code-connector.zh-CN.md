# T3 Code Connector

T3 Code Connector 以外部 Agent 的身份登录正在运行的 T3 Code 环境，通过 Agenvo 的 `search` / `execute` 暴露该环境原生 MCP 服务中的编排工具。共享范围是这次登录获准访问的整个环境，包括其他客户端创建的项目和线程。Agenvo 不启动或停止 T3 Code，不持有第二套线程历史、队列或执行状态机。

## 接口来源

T3 Code 原生提供 MCP 服务，入口是环境地址后的 `/mcp`，协议为 Streamable HTTP。接入方式见官方文档 [Outside agents](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)，授权模型见 [Environment authentication](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md#mcp-clients-are-a-separate-audience)。验证基线是 T3 Code `0.1.6`；固定版本只用于复现，不是运行时白名单。

方法目录在每次连接时从原生 `tools/list` 读取，沿用原生工具名、输入 schema 和描述，`annotations.readOnlyHint` 对应 `readOnly`，缺少标注的工具按写操作处理。仓库不复制原生 schema，也不维护版本快照；原生新增参数直接可见，删除的工具不再出现在目录中。

## 暴露范围

只暴露与环境本身相关的编排工具：

| 资源 | 原生工具 |
| --- | --- |
| 能力与环境 | `orchestrator_capabilities`、`t3_environment_read` |
| 项目 | `t3_project_list`、`t3_project_read`、`t3_project_create`、`t3_project_update`、`t3_project_delete`、`t3_project_clone` |
| 线程 | `t3_thread_list`、`t3_thread_search`、`t3_thread_read`、`t3_thread_launch`、`t3_thread_send`、`t3_thread_wait`、`t3_thread_interrupt`、`t3_thread_update`、`t3_thread_configure`、`t3_thread_organize`、`t3_thread_transfer` |
| 队列与待处理请求 | `t3_queue`、`t3_pending_request` |

原生目录中的其他工具要么依赖"调用者所在的 T3 线程"（`delegate_task`、`task_*`、`t3_worktree_handoff`、`t3_background_wait`、附件、PR 监视），要么依赖 T3 客户端的人机界面（`preview_*`、`device_*`、`html_render` / `html_preview`），还有定时任务和密钥请求。外部调用者没有当前线程，也看不到这些界面；暴露出来只会产生无法完成的调用。这是对原生能力的有意删减，由用户确认。目录描述在原生描述前补充共同术语：`create work context`（`t3_thread_launch`）、`submit input`（`t3_thread_send`）、`read output`（`t3_thread_read`）、`interrupt`（`t3_thread_interrupt`）、`respond`（`t3_pending_request`）。

## 登录与授权

`agenvo-t3code instance add --endpoint https://ENVIRONMENT/mcp` 走原生的外部 Agent OAuth：读取 protected resource 与 authorization server 元数据，以公共客户端动态注册（T3 Code 的注册无状态），使用 S256 PKCE 和本机 loopback 回调。环境所有者在 T3 Code 自己的批准页上输入配对码（设置页或 `t3 auth pairing create`），或用有 `access:write` 权限的已登录浏览器批准，并在页面上选择只读或某个 runtime mode 上限。浏览器不在 Connector 所在机器上时，可以把批准后的最终地址粘贴回终端。

Connector 不调用批准页背后未写入文档的接口，不代替所有者批准；隔离系统测试为了自动化才使用该接口。`t3 auth session issue` 签发的普通 bearer token 不被 `/mcp` 接受，因此不提供这条配置路径。

令牌保存在 Connector 配置目录的 `tokens/` 下，文件名使用实例 ID 的可移植编码；Unix 权限为 0600，Windows 需用仅当前用户可访问的 ACL 保护配置目录。令牌不进入 `config.json`、日志或实例 scope。原生令牌有效期 30 天且没有刷新令牌；到期或被所有者撤销后，Connector 报告不可用，`doctor` 提示运行 `agenvo-t3code instance login --id ID` 重新登录，然后重启 Connector。实例 scope 包括 endpoint 和令牌文件路径；重新登录不改变 scope，不需要在 Relay 重新批准实例。

执行权限由 T3 Code 持有：所有者批准时选择的上限签入令牌，经 Agenvo 启动或推进的线程不能超过它。Connector 不增加权限参数，也不改写调用参数。实例的 execution 描述为 `native-mcp-grant-ceiling`。

## 结果与连接

调用转发为原生 `tools/call`，结果保留原生 `structuredContent`（没有时保留 `content`）。`isError: true` 报告 rejected 并保留原生错误；MCP 参数错误同样是 rejected。参数中的 `threadId`、`projectId`、`runId`、`requestId` 以及结果中同名字段作为 nativeIds 返回。

写操作超时或丢失响应报告 unknown，读操作报告 not_started；任何调用都不自动重试。认证失败报告 rejected：T3 Code 在执行工具前校验凭据。Relay 单次调用上限是 10 秒，Connector 为原生调用留 9 秒；`t3_thread_wait` 的描述提示调用者传入更短的原生 `timeoutMs` 并重复调用。

MCP 会话在连接时建立，每 30 秒 ping 一次。环境重启会丢弃 MCP 会话；Connector 发现后标记不可用并重新连接，只重建会话和方法目录，不重放业务调用。关闭 Connector 只结束 MCP 会话，不停止环境或其中的运行。

## 事件

T3 Code 的 MCP 服务不推送线程变化通知，只有 `notifications/tools/list_changed`。第一版不提供 `runtime.changed` 事件，调用者用 `t3_thread_wait` 或 `t3_thread_read` 观察。T3 Code 的 WebSocket RPC 不接受 `mcp-client` 会话，不能作为补充事件源。

## 验证

- `tests/t3code.test.ts`：OAuth PKCE 登录与 0600 令牌、缺失/过期/权限不当的令牌、目录分页和筛选、共同术语、原生拒绝及超大错误的帧限制、未暴露工具、丢失写响应不重试、读操作失败为 not_started、环境重启与撤销后的可用性。
- `tests/integration/t3code.test.ts`：经真实 Relay MCP 的搜索、已有线程、输入、等待、读取、回答待处理问题、原生拒绝、requestId 与 Connector 重启后不重放。
- `tests/system/t3code-threads.test.ts`：隔离的 T3 Code `0.1.6`，Codex provider 指向本地模型 fixture；配对码批准登录、外部 CLI 创建的项目、通过 MCP 创建线程并得到模型输出、Connector 重启后继续同一线程、原生拒绝。

以上测试不覆盖 T3 Connect 远程地址、ChatGPT 等托管客户端，也不覆盖 Claude、OpenCode 等其他 provider 的实际执行。
