# Lody cloud and local connections

[简体中文](lody.zh-CN.md) · [Installation](installation.md) · [Management](management.md)

`agenvo-lody` supports cloud workspaces and local daemon attachment. Both instance types can coexist in one Connector; each instance keeps its connection path without automatic failover or input replay. Lody owns execution. The Connector attaches to existing services and does not install, start, or stop a daemon.

After setup, [add instance context](usage.md#add-instance-context) from the known environment and user requirements so callers can discover working conventions and other useful information.

## Cloud configuration and pairing

Obtain a CLI token from Lody's Account settings and save it to a private file. Store only the token; use mode 0600 on Unix or a user-only ACL on Windows. Use the workspace ID from Lody, not its display name or URL slug.

```sh
agenvo-lody instance add --id lody-cloud --mode cloud --workspace-id WORKSPACE_ID --token-file /absolute/path/to/lody-token
agenvo-lody connect https://relay.example.com --name cloud-lody
agenvo-lody doctor
agenvo-lody run
```

The default configuration directory is `~/.config/agenvo/lody`. Instance setup verifies the token and workspace and records the account ID. Configuration contains the token file path, never the token itself. One instance exposes one workspace, including accessible Sessions created by other clients. The underlying CLI token can have broader account access; protect the file accordingly. Account or workspace changes require rediscovery and Agenvo scope approval. Token rotation within the same account is read from the file automatically.

The official cloud endpoints are defaults. `--auth-url` and `--auth-site-url` can select another HTTPS deployment. The Streams gateway and shard topology come from the cloud token response. Device pairing and MCP client authorization follow the [usage guide](usage.md).

`doctor` checks authentication and cloud synchronization. Execution additionally requires permission to use the selected Lody machine/project and an online machine.

## Local attachment

Start the daemon using Lody first. OSS defaults to `~/.lody-oss`; the cloud edition defaults to `~/.lody`. Use `--data-dir` for a custom installation. The Connector reads the daemon run file and catalog identity, then uses Unix sockets or Windows named pipes without opening its private databases.

```sh
agenvo-lody instance add --id lody-local --mode local --platform local
# Attach to the cloud edition's daemon on this machine:
agenvo-lody instance add --id lody-on-this-machine --mode local --platform cloud --workspace-id WORKSPACE_ID
agenvo-lody doctor
```

A local instance manages only Sessions on the attached machine. Select `--workspace-id` when multiple workspaces are available. Local attachment accepts no CLI token; OSS has durable `local:` user and `lw_` workspace identities. An installation identity change requires rediscovery and authorization. Agenvo Relay device pairing and client authorization still apply.

`--platform` selects the installation to attach to; it does not change Lody's build mode. npm `lody@0.104.0` is compiled as the cloud edition and cannot become OSS through `LODY_PLATFORM=local`. Use an already running OSS daemon or attach to an authenticated cloud-edition daemon with `--platform cloud`.

Local attachment does not call Lody cloud APIs. OSS requires no Lody cloud account; a cloud-edition daemon still follows its native synchronization and authorization rules. Network requirements for the model and Agenvo Relay depend on their configuration.

## Discover, create and use a Session

Use `search` to discover instances and native methods, then invoke them with `call(target, method, params)` inside `execute`. `lody.sessions.list` includes existing Sessions with their native `id`; `lody.sessions.get` reads synchronized metadata and `lody.sessions.live` samples current activity through cloud RPC or local invocation RPC and presence. Durable status does not establish current execution or task success.

Call `lody.catalog` with no arguments to discover machines, then with `machineId` to discover that machine's agent configurations, capabilities and projects. Secret provider configuration is excluded. Create a Session in `execute` with:

```javascript
const target = { deviceId: "DEVICE_ID", instanceId: "INSTANCE_ID" };
return await call(target, "lody.sessions.create", {
  machineId: "MACHINE_ID",
  agentConfigId: "AGENT_CONFIG_ID",
  title: "Lody task"
});
```

The call outcome contains `result.session.id`. Creation writes Session metadata without a prompt. An optional native `project` selects a GitHub repository/branch or a project registered on the execution machine. Creating a context does not prove the provider can execute successfully; Lody retains its native empty-Session lifecycle.

`lody.sessions.send` accepts `sessionId`, `text`, and optional `modelId`, `modeId` and `configOptionValues`. Any agent configuration from `lody.catalog` can be used, including builtin, registry and custom ACP agents. Agenvo checks the selections against the capability that Lody published for that configuration (`modes`, `models`, `configOptions`) before writing, because the native daemon forwards user-turn selections to the agent without checking them. If Lody has not probed the configuration yet (a few seconds after it is created, until the agent first runs), a selection is rejected with `unsupported_capability`; omit it or retry.

Without `modeId` or `configOptionValues`, builtin Codex (`agent-full-access`), Claude (`bypassPermissions`), DeepSeek Harness (`danger-full-access`) and Kimi (mode `yolo`, or a `permission_mode` option `yolo`) configurations that advertise that setting run in full access, and plain execution permissions are approved automatically. Every other configuration, including Grok, registry and custom agents, runs on its native default and its permission requests stay explicit interactions. Capability shapes for Kimi were checked against the Kimi Code runtime without an account; DeepSeek, Grok and registry configurations are recognised from static bundle data and have not been run (Grok needs a grok.com login). To run Grok unattended pass `configOptionValues: { "permission_mode": "always-approve" }`; this and any other explicit selection also turns automatic approval off. Lody owns busy-input dispatch. Agenvo adds no queue and does not replay input automatically.

`cloud_input_synced` means the history and activation marker reached the cloud. It does not mean the machine started execution or the task succeeded. A timeout after writing returns `unknown` with native identities under `error.native`; inspect the Session before sending again. `local_input_received` means the daemon returned a version vector covering the writes; it does not acknowledge disk persistence, cloud upload, or execution completion. The Connector retains protocol replicas in memory and rebuilds them from the connected service after restart; unconfirmed writes have no Connector-side recovery guarantee.

## Read, observe and control

- `lody.sessions.history` pages native history. Large turns retain identity and result fields with `truncated: true`; read the full body using `lody.sessions.turn`, which returns JSON text fragments. Pass its `hash` as `expectedHash` with `nextOffset` to detect concurrent edits.
- `lody.sessions.history` accepts `afterTurnId`, a native turn id from an event, a truncated read target or an earlier read, to start strictly after that turn in the current native order instead of at the beginning. An unknown id (never existed, or removed by a native edit) is `not_found`; combining it with `cursor` is `invalid_params`; after the newest turn the result is empty without `nextCursor`. The turn is looked up on every call, so the call stays deterministic if earlier turns changed; the returned `nextCursor` is an ordinary cursor and is rejected with `invalid_cursor` if native history moved underneath it. Cloud and local attachment read the same synchronized document and behave identically. To read the named turn itself, use `lody.sessions.turn`.
- To be woken only when input is needed, subscribe with `nativeTypes: ["lody.interaction.pending"]`. It is announced once per native permission request or question that no automatic approval will answer, with `turnId`, `requestId`, the native `permissionRequest` (options, `_meta`) and `title`; answer it with `lody.interactions.respond` using those identifiers. `lody.interaction.resolved` follows when the request has an outcome: `outcome` is the native outcome (absent if the turn ended without one) and `resolvedBy` is `agenvo_respond` or `agenvo_auto_approve` when this Connector wrote it, and absent when another client or the provider did. Neither event proves that the provider consumed the answer or that the task succeeded. Plain execution permissions that this Connector approves in a full-access turn produce only `resolved`. After a Connector restart or reconnect `permissionHandling` is `unknown`, nothing is approved automatically, and such requests are announced as `pending`. An oversized request keeps its identifiers, option ids and `agenvo.read` (`lody.interactions.list`).
- `lody.capability.published` announces that the daemon published or changed an agent configuration's ACP capability row, with the native row in `native.capability` and `native.agenvo` (`agentConfigId`, `agentType`, `cliType`, `machineId`, `read`: `lody.catalog` for that machine). It has no `threadId`, so a `threadId` filter excludes it; filter with `nativeTypes: ["lody.capability.published"]`. A selection (`modeId`, `modelId`, `configOptionValues`) rejected with `unsupported_capability` before publication can be retried when this event arrives; the selection is still validated against the new row. Rows that already existed when the connection started, and rewrites with identical content, are not announced, and a removed row is not announced. Local attachment always watches its own machine. Cloud attachment watches a machine once this connection has opened it through `lody.catalog`, `lody.sessions.create` or `lody.sessions.send`; a machine never opened is not watched, so read `lody.catalog` for current state. An oversized row is reduced to the mode, model and option identifiers.
- Observation needs no call. The Connector watches Session metadata for the whole attachment and opens the history of Sessions whose native status is `initializing`, `running` or `requestPermission` (or that have a pending user question or a processing user turn), so their `history.updated` events arrive on their own. A Session that returns to idle is released after a grace period (30 seconds) that lets the final turn arrive. Reading with `lody.sessions.history`, `lody.sessions.turn` or `lody.interactions.list` only leases the document for the call; idle documents are evicted, least recently used first, so reads never consume the 128-document capacity permanently. At most 128 Session documents are open at once; if every slot is held by an active Session, a Session that cannot be observed is reported with `agenvo.resync_required` (`reason: "observation_capacity"`, `scope: "session"`, `sessionId`) and reads of it fail with `resource_exhausted` until another Session goes quiet. Initial history synchronization is not a completion event: turns that land before a Session's history finished opening are part of its initial snapshot and produce no `history.updated`, so after a `doc-metadata` status change read the history rather than relying on turn events alone. There is no observation journal; after a disconnect the Connector re-observes active Sessions by itself, and a consumer rereads state (`lody.sessions.get`, `lody.interactions.list`) for the Sessions it cares about.
- **Breaking change from 0.2.0: `lody.sessions.subscribe` was removed.** It only opened a Session document, which is now automatic. Delete calls to it; do not replace them. MCP event subscriptions (`events/subscribe`, `nativeTypes: ["history.updated"]`, `threadId`) work unchanged and no longer require a prior call. After `agenvo.resync_required` do not subscribe again; read `lody.sessions.get` and `lody.interactions.list` for the affected Session (or all watched Sessions for `scope: "workspace"`). A call to the removed method returns `unsupported_capability`.
- Lody events reach MCP clients as `runtime.changed` with native types: `doc-metadata` (native Session metadata patch, including `status.type` and `awaitingUserSince`) and `history.updated` (a native turn). Each event adds `native.agenvo` with `sessionId`, `agentConfigId`, `agentType`, `cliType`, `machineId`, `turnId` when the event concerns a turn, and `permissionHandling` (`auto_approve_plain`, `explicit`, or `unknown` when this Connector did not choose the policy). Use `agentConfigId` with `lody.catalog` to interpret provider-specific turns. Native data above 24 KB is reduced to identity plus `truncated`, `omittedBytes` and `agenvo.read`, which names the method and identity to read the full state (`lody.sessions.turn` or `lody.sessions.get`). `agenvo.resync_required` carries `scope`: `workspace` after a disconnect, or `session` with a `sessionId` when only one Session lost continuity; reread that Session. Cloud attachment reports metadata events for the whole authorized workspace, like `lody.sessions.list`; local attachment reports only the attached machine.
- `lody.interactions.list` returns pending native requests, `sessionId`, `turnId`, `requestId` and the response schema. `lody.interactions.respond` takes those native identifiers and an `outcome`. Plain execution permissions for controlled Sessions are approved automatically; questions and requests with unknown metadata remain explicit. Synchronization does not acknowledge provider consumption or winning a concurrent response race.
- `lody.sessions.cancel` requires explicit `sessionId` and `turnId` and cancels that exact turn once. Get the active local turn ID from `lody.sessions.live`; for cloud, read the unfinished assistant turn from `lody.sessions.history`. A rejection or timeout never retargets another turn.
- `lody.sessions.steer` requires `expectedTurnId` and accepts the same optional selections as send. If the provider cannot steer, Lody requeues the input as a follow-up turn; the result has `confirmation: "native_steer_requeued"` with the native `disposition` and `recoveryOwned`. Other uncertain results stay `unknown` and are not replayed.
- `lody.sessions.archive/restore` changes native archival metadata. Archival can stop execution and release resources; restore does not promise provider resume.

The connector targets the public-source Lody client protocol. Cloud protocol tests use a real isolated Loro Streams server with fixture account and execution peers; authenticated production cloud acceptance remains outstanding. Local system tests use the native Lody 0.104.0 daemon/ACP, real Codex and an isolated model through Relay MCP, including reconnect behavior. The test assembly changes only the published bundle's platform selection constants to OSS; protocol and execution code remain unchanged.
