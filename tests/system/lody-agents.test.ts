import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { nativeLody } from "../support/lody-native.js";
import { until } from "../support/environment.js";
import { LocalConnection } from "../../apps/lody/src/local.js";
import { LodyAdapter } from "../../apps/lody/src/lody.js";

test(
  "native Lody daemon with a non-Codex ACP agent: validated selections, explicit permissions and steer recovery",
  { timeout: 120000 },
  async (t) => {
    const lab = await eventsLab(t);
    const native = await nativeLody(lab.root);
    lab.cleanup(() => native.close());
    t.after(() => {
      if (t.passed === false) console.error(native.logs().slice(-8000));
    });
    if (native.config.mode !== "local") throw new Error("Expected local");
    const config = native.config;
    const peer = new LocalConnection(config);
    lab.cleanup(() => peer.close());
    await peer.start();
    const meta = await peer.repo.joinMetaRoom();
    await meta.waitFor({ phase: "caught-up", timeoutMs: 6000 });
    const name = `${config.workspaceId}:mf:${config.machineId}`;
    const { flock } = await peer.repo.openFlockDoc(name);
    const room = await peer.repo.joinFlockDocRoom(name);
    await room.waitFor({ phase: "caught-up", timeoutMs: 6000 });
    const log = join(lab.root, "acp.log");
    // A custom ACP agent stands in for providers that need accounts. The daemon
    // launches it, probes its capabilities and dispatches turns exactly as it
    // would for a builtin provider.
    flock.set(["agentConfig", "acp"], {
      id: "acp",
      machineId: config.machineId,
      name: "Mock ACP",
      cliType: "custom",
      agentType: "mock",
      env: { ACP_MOCK_LOG: log },
      customAcp: {
        command: process.execPath,
        args: [resolve("tests/support/acp-agent.mjs")],
      },
    });
    flock.commit();
    await peer.uploaded(room);
    const adapter = new LodyAdapter(config);
    await adapter.init();
    lab.cleanup(() => adapter.close());
    const call = async (method: string, params = {}) => {
      const result = await adapter.call(method, params);
      assert.equal(result.error, undefined, JSON.stringify(result));
      return result.result as any;
    };
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const requests = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const text = async (sessionId: string) =>
      JSON.stringify(await call("lody.sessions.history", { sessionId }));
    const start = async () =>
      (
        await call("lody.sessions.create", {
          machineId: config.machineId,
          agentConfigId: "acp",
        })
      ).session.id as string;

    // The daemon publishes capability only after it first runs the agent.
    const first = await start();
    const early = await adapter.call("lody.sessions.send", {
      sessionId: first,
      text: "too early",
      modeId: "yolo",
    });
    assert.equal(early.error?.code, "unsupported_capability");
    assert.deepEqual(await requests(), [], "nothing may reach the agent");
    await call("lody.sessions.send", { sessionId: first, text: "probe" });
    await until(
      async () => flock.get(["acpCapability", "acp"]) as any,
      (row) => row?.modes?.length,
      30000,
    );

    // Valid selections reach the ACP agent, including a non-mode option.
    const chosen = await start();
    await call("lody.sessions.send", {
      sessionId: chosen,
      text: "selected",
      modeId: "yolo",
      modelId: "mock-large",
      configOptionValues: { permission_mode: "always-approve" },
    });
    await until(
      () => text(chosen),
      (r) => r.includes("mode=yolo model=mock-large permission=always-approve"),
      30000,
    );
    const methods = (await requests()).map((r) => r.method);
    for (const m of [
      "session/set_mode",
      "session/set_model",
      "session/set_config_option",
    ])
      assert.ok(methods.includes(m), m);

    // Invalid selections are stopped by Agenvo; the daemon would forward them.
    const before = (await requests()).length;
    const invalid = await adapter.call("lody.sessions.send", {
      sessionId: await start(),
      text: "invalid",
      modeId: "nope",
    });
    assert.equal(invalid.error?.code, "invalid_params");
    assert.equal((await requests()).length, before);

    // Native defaults: a permission request is not answered for the caller.
    const guarded = await start();
    await call("lody.sessions.send", {
      sessionId: guarded,
      text: "NEEDS_PERMISSION",
    });
    const pending = await until(
      () => call("lody.interactions.list", { sessionId: guarded }),
      (r) => r.items.length === 1,
      30000,
    );
    // Every event of the Session tells a receiving Agent which configuration
    // produced it, which turn it concerns and how permissions are handled,
    // without a prior subscribe call.
    const own = events.filter((e) => e.threadId === guarded);
    assert.ok(own.length > 0);
    for (const e of own) {
      assert.equal(e.native.agenvo.sessionId, guarded);
      assert.equal(e.native.agenvo.agentConfigId, "acp");
      assert.equal(e.native.agenvo.cliType, "custom");
      assert.equal(e.native.agenvo.machineId, config.machineId);
    }
    const waiting = await until(
      async () =>
        events.find(
          (e) =>
            e.threadId === guarded &&
            e.nativeType === "doc-metadata" &&
            e.native.patch?.status?.type === "requestPermission",
        ),
      Boolean,
    );
    assert.equal(waiting.native.agenvo.permissionHandling, "explicit");
    const asked = own.find(
      (e) =>
        e.nativeType === "history.updated" &&
        JSON.stringify(e.native.turn).includes("permissionRequest"),
    );
    assert.equal(asked.native.agenvo.turnId, pending.items[0].turnId);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(
      (await call("lody.interactions.list", { sessionId: guarded })).items
        .length,
      1,
      "no automatic approval outside a full-access policy",
    );
    // This provider cannot steer: the daemon requeues the input and says so.
    const steered = await call("lody.sessions.steer", {
      sessionId: guarded,
      text: "follow up",
      expectedTurnId: pending.items[0].turnId,
    });
    assert.equal(steered.confirmation, "native_steer_requeued");
    // The requeued input stays correlatable: its turn identity is the one the
    // call returned, and its history events carry that turn.
    await until(
      async () =>
        events.find(
          (e) =>
            e.nativeType === "history.updated" &&
            e.native.turn.id === steered.userTurnId,
        ),
      Boolean,
    );
    assert.equal(steered.disposition, "unsupported");
    assert.equal(steered.recoveryOwned, true);
    await call("lody.interactions.respond", {
      sessionId: guarded,
      turnId: pending.items[0].turnId,
      requestId: pending.items[0].requestId,
      outcome: { outcome: "selected", optionId: "allow" },
    });
    const asked2 = events.find(
      (e) =>
        e.threadId === guarded && e.nativeType === "lody.interaction.pending",
    );
    assert.equal(asked2.native.requestId, pending.items[0].requestId);
    assert.equal(asked2.native.agenvo.turnId, pending.items[0].turnId);
    assert.equal(asked2.native.agenvo.agentConfigId, "acp");
    const answered = events.find(
      (e) =>
        e.threadId === guarded && e.nativeType === "lody.interaction.resolved",
    );
    assert.equal(answered.native.outcome.optionId, "allow");
    assert.equal(answered.native.resolvedBy, "agenvo_respond");
    await until(
      () => text(guarded),
      (r) => r.includes("MOCK_ACP_RESULT") && r.includes("follow up"),
      30000,
    );
    assert.equal(native.child.exitCode, null);
  },
);
