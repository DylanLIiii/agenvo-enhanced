# T3 Code

[English](t3code.md) · [使用指南](usage.zh-CN.md)

通过原生 MCP 服务登录正在运行的 [T3 Code](https://t3.codes/) 环境。Agenvo 共享该环境的项目和线程，包括在 T3 Code 应用中或由其他 Agent 创建的线程。关闭或重启 Connector 不影响 T3 Code 及其运行。

## 安装与登录

此 Connector 是当前源码树中的新增能力，尚未发布。在本 checkout 中运行 `npm ci`、`npm run build --workspace @agenvo/t3code` 和 `npm link --workspace @agenvo/t3code`。需要 Node.js 24.13+。T3 Code 由你自己运行（桌面应用、`t3 serve` 或其后台服务），provider 也在 T3 Code 中配置。

在 T3 Code 的 **Settings → Environments → Copy MCP URL** 复制 MCP 地址，即环境地址后加 `/mcp`。在 T3 Code 所在主机上通常是 `http://127.0.0.1:3773/mcp`。从其他机器访问时使用 HTTPS，例如 T3 Connect 或 Tailscale HTTPS：T3 Code 只在 HTTPS 或 localhost 上完成登录。

```sh
agenvo-t3code instance add --id t3 --endpoint http://127.0.0.1:3773/mcp
agenvo-t3code doctor
agenvo-t3code connect https://relay.example.com --name laptop-t3code
agenvo-t3code run
```

`instance add` 会打开 T3 Code 的登录页。输入 **Settings → Sharing & access** 或主机上 `t3 auth pairing create` 给出的配对码，再选择 Agenvo 的权限：**Read only**，或最高到 **Full access** 的 runtime mode 上限。经 Agenvo 启动或推进的线程不能超过这个上限。使用 `--no-browser`，或浏览器在另一台机器上时，自行打开输出的地址，批准后把最终地址粘贴回终端。

登录结果保存在 `~/.config/agenvo/t3code/tokens/` 下，Unix 权限为 0600；Windows 需要用仅当前用户可访问的 ACL 保护配置目录。有效期 30 天。到期或在 **Settings → Sharing & access** 中撤销 Agenvo 后，`doctor` 会报告；重新登录并重启 Connector：

```sh
agenvo-t3code instance login --id t3
```

[实例上下文](usage.zh-CN.md#补充实例上下文)可以说明 T3 Code 所在主机。项目目录指 T3 Code 主机上的路径，不是 Connector 所在机器。验证基线是 T3 Code 0.1.6；其他版本不会仅因版本号被拒绝。

## 发现与使用原生工具

限定目标设备和实例，搜索 `create work context`、`submit input`、`read output`、`interrupt` 或 `respond`。方法就是 T3 Code 自己的 MCP 工具，沿用原生名称和参数。Agenvo 只暴露编排工具：能力与模型、项目、线程、排队输入和待处理问题。需要调用者所在 T3 线程或 T3 Code 界面的工具（预览、设备、HTML 渲染、委派、worktree 交接、定时任务）不暴露。

以下 `execute` 脚本列出每个项目的线程：

```js
const target = { deviceId: "DEVICE_ID", instanceId: "t3" };
const { result } = await call(target, "t3_project_list", {});
const threads = [];
for (const project of result.projects)
  threads.push(await call(target, "t3_thread_list", { projectId: project.id }));
return threads.map((t) => t.result);
```

创建线程并提交第一条消息。项目没有默认模型时需要传 `modelSelection`，可选值从 `orchestrator_capabilities` 读取：

```js
const target = { deviceId: "DEVICE_ID", instanceId: "t3" };
return await call(target, "t3_thread_launch", {
  title: "Fix the flaky test",
  projectId: "PROJECT_ID",
  message: "Find why the tests are slow.",
  modelSelection: { instanceId: "codex", model: "MODEL_ID" }
});
```

`t3_thread_send` 向已有线程提交输入，原生 `mode` 决定启动、引导、排队还是重启运行。输入被接受不代表运行结束或任务成功。用 `t3_thread_wait` 观察，原生 `timeoutMs` 小于 10 秒，运行未结束时再次调用，然后用 `t3_thread_read` 读取输出。`t3_pending_request` 列出并回答 Agent 正在等待的问题；用户决定不会被自动代答。

结果是工具的原生结构化结果。原生工具错误报告为 `rejected`，保留 T3 Code 的消息。写操作丢失响应报告为 `unknown`，先检查线程再决定是否重试；Connector 不会重发输入。T3 Code 的 MCP 服务不推送线程变化，因此此 Connector 没有[事件订阅](events.zh-CN.md)，用 `t3_thread_wait` 或 `t3_thread_read` 轮询。
