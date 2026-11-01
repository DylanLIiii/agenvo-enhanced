# Use native Agent capabilities

[简体中文](management.zh-CN.md) · [Usage](usage.md)

Agenvo exposes two MCP tools: `search` accepts keywords and `execute` accepts a JavaScript function body. Discover the target and exact method schema, then compose native calls. Thread is the work context; Agenvo does not define a second Thread or Turn model.

## Discover

Pass an empty query to search to list approved instances and online status without loading method catalogs:

```json
{"query": ""}
```

Browse method summaries by operation, then select a target and method name to retrieve its full schema:

```json
{"query": "submit input"}
```

```json
{"query": "thread/start", "deviceId": "DEVICE_ID", "instanceId": "coding", "includeSchema": true}
```

The response's result.items contains instances and matching methods, each with only name, description and readOnly by default. To discover parameters, narrow the target and method name and pass includeSchema: true for the full inputSchema. Omitting includeSchema or passing false returns summaries; descriptions remain intact to preserve calling constraints. Empty queries still list only instances, even with true.

Queries are case-insensitive whitespace-separated keywords; all words must occur in the connector kind, method name or description. Search does not execute code, evaluate regular expressions or perform semantic search. Search for codex or herdr to list all methods of that kind; deviceId and instanceId narrow the target.

A deviceId identifies a Connector, not a physical machine. Offline or unavailable instances retain their status or error; a failed method lookup may leave partial results. Online instances without matching methods are omitted from nonempty searches. Names are unique within an instance; no Agenvo namespace is required.

Both Connectors use common operation terms: list, create, read, submit input, interrupt and respond. A work context is a conversation thread in Codex and a terminal running an agent in Herdr Core. A Herdr Core session is an independently running service. Native method and field names remain unchanged, preserving these differences.

Discovery results also carry the optional owner-supplied `context` text unchanged. Read it when choosing and using an instance. Empty queries, matching method queries, and offline instances can all include the last announcement. Context does not participate in method keyword matching, guarantee live capabilities or permissions, or automatically enter native calls. See [instance context configuration](usage.md#add-instance-context).

Search may also return optional `result.updates` for newer formal Agenvo server and Connector versions within the selected approved scope. These are release notices, not native runtime updates or compatibility guarantees. See [Updating](updating.md) to assess and apply them with existing tools. Missing notices do not prove the installed versions are current.

## Execute

### Paseo terminals and projects

Discover `paseo.terminals` to create a plain shell in an existing workspace,
list terminals, run commands, capture output, send text or keys, and close a
terminal. These operations do not start an Agent. Keep the returned native
terminal ID. `run` adds Enter; `send-text` adds nothing. Input confirmation
means transport submission only: Paseo does not acknowledge terminal input or
report a command's exit status. The Connector does not automatically replay
input. After an uncertain result, inspect output and decide whether retrying
is appropriate for the operation.

`read` preserves Paseo's native capture `start`/`end` offsets. Narrow the range
if a capture exceeds the relay result limit. `send-keys` accepts Paseo key
descriptors such as `{key: "Enter"}` or `{key: "c", ctrl: true}` and uses
Paseo's native encoder in normal mode by default. When needed, pass an optional
`inputMode` override: `{applicationCursorKeys: true}` for application cursor
keys, or the application's `kittyKeyboardFlags` / `win32InputMode` for modified
Enter. Omitted fields use normal-mode values. The Connector does not detect
the application's input mode. Unsupported keys reject the whole batch before
any input is sent.

To register a cloned directory in Paseo's project list, discover
`paseo.projects.add` and pass its `cwd`, then verify with
`paseo.projects.list`. Creating a workspace and registering a project are
different operations; neither clones a repository.

Pass this body to `execute`, replacing the target with discovered IDs:

```js
const target = {deviceId: "DEVICE_ID", instanceId: "coding"};
const created = await call(target, "thread/start", {});
if (created.error) return created;
const threadId = created.result.thread.id;
const sent = await call(target, "turn/start", {
  threadId, input: [{type: "text", text: "Inspect the failing tests."}]
});
return {threadId, sent};
```

`call` returns `{execution, requestId, result, nativeIds?, error?}`. Inspect errors in code; a native rejection is returned as data. Calls are independent, not transactional. Use loops for pagination and return only relevant fields. No host filesystem, network, environment variables or imports are available. Scripts have a 30-second deadline and a computation interrupt to stop stalled loops, with no additional call-count or script-result size quota. Already dispatched calls are collected before the response, so confirmation can extend beyond the script deadline by a native call timeout.

execute delivers strings verbatim as MCP text and serializes other JSON values directly. No return or undefined produces `null`. Successful scripts receive no result envelope or automatic call receipts. Return complete call outcomes, selected objects, or prose; explicitly return any execution confirmations, request IDs, or native IDs you need. Native rejections remain data for your script to inspect; a normally returning script has MCP isError false even if a native call was rejected.

If the script throws, times out, is interrupted, or returns a value that cannot be serialized, MCP isError is true. The response includes readable diagnostics, the script requestId, and confirmations for dispatched calls so you can inspect what already happened. Diagnostics are text for the calling Agent, not a fixed JSON path contract. `accepted` confirms submission, not business success. `starting` means initialization is still pending. After `unknown`, inspect native state before repeating a write. There is no automatic retry or rollback.

For example, return only thread IDs as text:

```js
const r = await call(target, "thread/list", {});
if (r.error) return r;
return r.result.data.map(thread => thread.id).join("\n");
```

Each native call uses the existing access authorization. If a later call is denied, earlier results remain available to assess progress; previous work is not undone.

### Wait between executions

`execute` does not provide timers such as `setTimeout` or `sleep`, or blocking waits for task completion or future output. Return after submitting input. The calling Agent decides when to read again and waits outside `execute`, using its own waiting mechanism or the [events protocol](events.md). Do not busy-wait or poll for completion inside a script. The 30-second deadline protects script execution; it is not a task-waiting budget.

For example, submit a Herdr command in one `execute`, using the discovered target and terminal address:

```js
return await call(target, "terminal.send", {terminal, text: "echo hi"});
```

After checking the receipt and waiting on the Agent side, read output in a separate `execute`. Define `target` and `terminal` again because script variables do not persist between executions:

```js
return await call(target, "terminal.read", {terminal, lines: 20});
```

Inspect the output to decide whether the command has finished. If output is not ready, wait outside `execute` before reading again. If a script fails after submitting input, inspect the confirmations attached to the error diagnostics and the native state before repeating the submission.

## Codex

Use `thread/list`, `thread/start`, `thread/read`, `thread/resume`, `thread/archive` and `thread/unarchive` according to their schemas. Native listing filters determine provider/source coverage; inspect these when discovering other clients' threads. Use `turn/start` for input, `turn/steer` with expectedTurnId, and `turn/interrupt` with a known turnId. An unloaded thread may require resume before input. Full-access execution and automatic permission responses apply to Agenvo work entry points.

`notifications.list({threadId, cursor?, limit?})` reads bounded events received on this connection. It is not durable history or guaranteed coverage of every thread. Resume a thread to subscribe; resume does not replay past output. Retain nextCursor and inspect gap after eviction or reconnection. Native history may be unavailable for empty or ephemeral threads or in some runtime versions. Use native history when available and notifications for received output.

`requests.list({threadId?, cursor?})` returns pending user questions and tool calls, including their parameters and responseSchema. Select the desired entry inside execute, then answer with `requests.respond({interactionId, result})`. IDs are connection-scoped; expired or duplicate responses fail. Submission does not prove your answer won a race with another client. Permission approvals are automatic and do not enter this pending list.

## Herdr Core

Each instance connects to one independently running Core session. `terminal.list` includes existing terminals from other clients and machines connected to that Core; addresses such as `box/t7` remain native. `terminal.run` starts a program or template in a new terminal; pass `argv`, `cwd`, `on`, and execution settings as appropriate. Templates may send an initial message: inspect `first_message`. After an unknown result inspect the terminal list before retrying.

`terminal.send` pastes text and presses Enter; it refuses a blocked program unless `force` is set. Inspect the question before using `force` to answer. `terminal.keys` sends native keys and `terminal.interrupt` reports the effect of a stop key. `terminal.kill` stops a program; `terminal.rm` removes a finished record. Connector shutdown does not stop Core or its terminals.

`terminal.read` returns `text`, `complete`, `how` and `why`; `lines` selects history above the screen. Full-screen applications may only expose their screen while working, and a snapshot is not a durable transcript. `terminal.get` reports only status supplied by the program via OSC 7501; programs without reports have no status. Neither idle nor done proves task success. Use [events](events.md) to decide when to read, and re-read after a resync.

```js
const read = await call(target, "terminal.read", {terminal, lines: 80});
if (read.error) return read;
return read.result.text;
```

Lody exposes native Sessions, history, exact-turn cancellation and interactions through `lody.*` methods. See the [Lody guide](lody.md) for cloud and local connection boundaries.
