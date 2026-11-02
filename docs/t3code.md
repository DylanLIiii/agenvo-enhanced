# T3 Code

[简体中文](t3code.zh-CN.md) · [Usage](usage.md)

Sign in to a running [T3 Code](https://t3.codes/) environment through its native MCP server. Agenvo shares the environment's projects and threads, including threads started in the T3 Code app or by other agents. Closing or restarting the Connector leaves T3 Code and its runs untouched.

## Install and sign in

This Connector is new in the current source tree and has not been published. From this checkout, run `npm ci`, `npm run build --workspace @agenvo/t3code`, and `npm link --workspace @agenvo/t3code`. Requires Node.js 24.13+. Run T3 Code yourself (desktop app, `t3 serve`, or its background service) and configure its providers there.

Copy the MCP URL from T3 Code's **Settings → Environments → Copy MCP URL**; it is the environment address followed by `/mcp`. On the T3 Code host, `http://127.0.0.1:3773/mcp` is typical. From another machine use HTTPS, such as T3 Connect or Tailscale HTTPS: T3 Code only completes sign-in over HTTPS or localhost.

```sh
agenvo-t3code instance add --id t3 --endpoint http://127.0.0.1:3773/mcp
agenvo-t3code doctor
agenvo-t3code connect https://relay.example.com --name laptop-t3code
agenvo-t3code run
```

`instance add` opens T3 Code's sign-in page. Enter a pairing code from **Settings → Sharing & access** or from `t3 auth pairing create` on the host, then choose what Agenvo may do: **Read only**, or a runtime-mode ceiling up to **Full access**. Threads started or steered through Agenvo cannot exceed that ceiling. With `--no-browser`, or when the browser runs on another machine, open the printed URL yourself and paste the final address back into the terminal after approving.

The sign-in is stored under `~/.config/agenvo/t3code/tokens/` with mode 0600 on Unix. On Windows, protect the configuration directory with user-only ACLs. It lasts 30 days. When it expires or you revoke Agenvo under **Settings → Sharing & access**, `doctor` reports it; sign in again and restart the Connector:

```sh
agenvo-t3code instance login --id t3
```

[Instance context](usage.md#add-instance-context) can describe the T3 Code host. Project folders refer to that host, not the Connector machine. The verified baseline is T3 Code 0.1.6; other versions are not rejected by version number.

## Discover and use native tools

Search for `create work context`, `submit input`, `read output`, `interrupt`, or `respond`, scoped to the intended device and instance. Methods are T3 Code's own MCP tools with their native names and parameters. Agenvo exposes the orchestration tools only: capabilities and models, projects, threads, queued input and pending questions. Tools that need a calling T3 thread or the T3 Code UI (preview, devices, HTML rendering, delegation, worktree handoff, scheduling) are not exposed.

This `execute` script lists threads in each project:

```js
const target = { deviceId: "DEVICE_ID", instanceId: "t3" };
const { result } = await call(target, "t3_project_list", {});
const threads = [];
for (const project of result.projects)
  threads.push(await call(target, "t3_thread_list", { projectId: project.id }));
return threads.map((t) => t.result);
```

Start a thread with its first message. A project without a default model needs `modelSelection`; read the choices from `orchestrator_capabilities`:

```js
const target = { deviceId: "DEVICE_ID", instanceId: "t3" };
return await call(target, "t3_thread_launch", {
  title: "Fix the flaky test",
  projectId: "PROJECT_ID",
  message: "Find why the tests are slow.",
  modelSelection: { instanceId: "codex", model: "MODEL_ID" }
});
```

`t3_thread_send` submits input to an existing thread; its native `mode` decides whether the input starts, steers, queues or restarts a run. Acceptance does not mean the run finished or the task succeeded. Use `t3_thread_wait` with a native `timeoutMs` under 10 seconds and call it again while the run continues, then read output with `t3_thread_read`. `t3_pending_request` lists and answers questions an agent is waiting on; user decisions are never answered automatically.

Results are the tool's native structured result. A native tool error is `rejected` with T3 Code's message. A lost write response is `unknown`; inspect the thread before deciding to retry. The Connector never resends input. T3 Code's MCP server does not push thread changes, so this Connector has no [event subscription](events.md); poll with `t3_thread_wait` or `t3_thread_read`.
