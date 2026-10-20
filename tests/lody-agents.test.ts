import test from "node:test";
import assert from "node:assert/strict";
import { lodyCloudFixture } from "./fixtures/lody-cloud.js";
import { LodyAdapter } from "../apps/lody/src/lody.js";
import { until } from "./support/environment.js";

const select = (id: string, category: string, values: string[]) => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue: values[0],
  options: values.map((value) => ({ value, name: value })),
});

// Agent configurations as the native daemon publishes them. Capability shapes
// follow lody@0.104.0: Kimi and Grok keep permissions in a `_permission` option,
// DeepSeek uses a `mode` option, Codex and Claude use ACP modes.
const agents = {
  claude: {
    cliType: "builtin",
    capability: { modes: [{ id: "auto" }, { id: "bypassPermissions" }] },
  },
  deepseek: {
    cliType: "builtin",
    capability: {
      modes: [],
      configOptions: [
        select("mode", "mode", ["workspace-write", "danger-full-access"]),
      ],
    },
  },
  // Shape recorded from the Kimi Code 2.0.2 ACP server with a fixture provider
  // (no account): `yolo` is an ordinary mode, also published as a `mode` option.
  kimi: {
    cliType: "builtin",
    capability: {
      modes: ["default", "plan", "auto", "yolo"].map((id) => ({ id })),
      configOptions: [
        select("model", "model", ["fixture"]),
        select("mode", "mode", ["default", "plan", "auto", "yolo"]),
      ],
    },
  },
  // Static bundle data lists Kimi's permission as a `_permission` option.
  kimiOption: {
    cliType: "builtin",
    agentType: "kimi",
    capability: {
      modes: [],
      configOptions: [
        select("permission_mode", "_permission", ["auto", "yolo"]),
      ],
    },
  },
  grok: {
    cliType: "builtin",
    capability: {
      modes: [{ id: "default" }],
      models: [{ modelId: "grok-4.6" }],
      configOptions: [
        select("permission_mode", "_permission", ["ask", "always-approve"]),
        { id: "plan", category: "mode_plan", type: "boolean", options: [] },
      ],
    },
  },
  // `yolo` means nothing for a third-party agent, so it is never defaulted.
  mystery: {
    cliType: "custom",
    capability: { modes: [{ id: "yolo" }], models: [{ modelId: "m1" }] },
  },
  // The daemon has not probed this configuration yet.
  unprobed: { cliType: "builtin", agentType: "codex" },
} as Record<string, { cliType: string; agentType?: string; capability?: any }>;

async function setup(t: test.TestContext) {
  const fixture = await lodyCloudFixture();
  t.after(() => fixture.close());
  const machine = await fixture.repo.openFlockDoc("workspace1:mf:machine1");
  for (const [name, agent] of Object.entries(agents)) {
    machine.flock.set(["agentConfig", name], {
      id: name,
      machineId: "machine1",
      name,
      cliType: agent.cliType,
      agentType: agent.agentType ?? name,
    });
    if (agent.capability)
      machine.flock.set(["acpCapability", name], agent.capability);
  }
  machine.flock.commit();
  const room = await fixture.repo.joinFlockDocRoom("workspace1:mf:machine1");
  await room.subscription("fixture").waitUntilSynced();
  const adapter = new LodyAdapter(fixture.config);
  t.after(() => adapter.close());
  await adapter.init();
  const start = async (agent: string) => {
    const created = await adapter.call("lody.sessions.create", {
      machineId: "machine1",
      agentConfigId: agent,
    });
    assert.equal(created.error, undefined, JSON.stringify(created));
    return (created.result as any).session.id as string;
  };
  const sent = async (sessionId: string, params = {}) => {
    const { doc } = await fixture.document(sessionId);
    const before = doc.getList("history").length;
    const result = await adapter.call("lody.sessions.send", {
      sessionId,
      text: "go",
      ...params,
    });
    const rows = doc.getList("history").toJSON() as any[];
    return {
      result,
      written: rows.length - before,
      config: rows[0]?.inputConfig,
    };
  };
  return { fixture, adapter, start, sent };
}

test(
  "Lody execution: full access defaults come from native capability ids, not agent type",
  { timeout: 60000 },
  async (t) => {
    const { start, sent } = await setup(t);
    const expected: Record<string, any> = {
      claude: { modeId: "bypassPermissions" },
      deepseek: { modeId: "danger-full-access" },
      kimi: { modeId: "yolo" },
      kimiOption: { configOptionValues: { permission_mode: "yolo" } },
      // Grok is deliberately caller-explicit; custom agents are never guessed.
      grok: {},
      mystery: {},
      unprobed: {},
    };
    for (const [agent, want] of Object.entries(expected)) {
      const { result, config } = await sent(await start(agent));
      assert.equal(
        result.error,
        undefined,
        `${agent}: ${JSON.stringify(result)}`,
      );
      assert.equal(config.modeId, want.modeId, agent);
      assert.deepEqual(
        config.configOptionValues,
        want.configOptionValues,
        agent,
      );
      assert.equal(config.agentType, agents[agent].agentType ?? agent);
    }
  },
);

test(
  "Lody execution: explicit selections are validated against capability before anything is written",
  { timeout: 60000 },
  async (t) => {
    const { start, sent } = await setup(t);
    const grok = await start("grok");
    const ok = await sent(grok, {
      modelId: "grok-4.6",
      configOptionValues: { permission_mode: "always-approve", plan: true },
    });
    assert.equal(ok.result.error, undefined, JSON.stringify(ok.result));
    assert.deepEqual(ok.config.configOptionValues, {
      permission_mode: "always-approve",
      plan: true,
    });
    assert.equal(ok.config.modeId, undefined);
    // An explicit mode replaces the full-access default instead of adding to it.
    const explicit = await sent(await start("claude"), { modeId: "auto" });
    assert.equal(explicit.config.modeId, "auto");
    const rejected: [string, any][] = [
      ["grok", { modeId: "bypassPermissions" }],
      ["grok", { modelId: "nope" }],
      ["grok", { configOptionValues: { permission_mode: "bogus" } }],
      ["grok", { configOptionValues: { unknown_option: "x" } }],
      ["grok", { configOptionValues: { plan: "yes" } }],
      ["grok", { configOptionValues: { permission_mode: true } }],
      ["mystery", { modeId: "other" }],
    ];
    for (const [agent, params] of rejected) {
      const { result, written } = await sent(await start(agent), params);
      assert.equal(
        result.error?.code,
        "invalid_params",
        JSON.stringify(params),
      );
      assert.equal(written, 0, "a rejected selection must not write history");
    }
    // Without published capability a selection cannot be checked, so it is not
    // passed through; omitting it still works.
    const blocked = await sent(await start("unprobed"), { modeId: "x" });
    assert.equal(blocked.result.error?.code, "unsupported_capability");
    assert.equal(blocked.written, 0);
  },
);

test(
  "Lody execution: only full-access turns approve plain permissions; questions stay explicit",
  { timeout: 60000 },
  async (t) => {
    const { fixture, adapter, start, sent } = await setup(t);
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const answered = async (id: string) =>
      (
        fixture
          .document(id)
          .then((d) => d.doc.getList("history").toJSON()) as Promise<any[]>
      ).then(
        (rows) =>
          rows.flatMap((r) => r.items ?? []).find((i) => i.permissionRequest)
            ?.permissionRequest.outcome,
      );
    const full = await start("kimi");
    await sent(full);
    await fixture.assistant(full, { finished: false, question: "plain" });
    await until(
      () => answered(full),
      (outcome) => outcome?.optionId === "allow",
      10000,
    );
    // An approval the Connector made is evidence, not a request for the consumer.
    const approved = await until(
      async () =>
        events.find(
          (e) =>
            e.threadId === full && e.nativeType === "lody.interaction.resolved",
        ),
      Boolean,
    );
    assert.equal(approved.native.resolvedBy, "agenvo_auto_approve");
    assert.equal(approved.native.outcome.optionId, "allow");
    assert.equal(approved.native.requestId, "plain1");
    assert.equal(approved.native.agenvo.turnId, "assistant1");
    assert.equal(
      events.some(
        (e) =>
          e.threadId === full && e.nativeType === "lody.interaction.pending",
      ),
      false,
    );
    // The same Session moves to an explicit policy: permissions are no longer
    // answered for it, and a native-default agent is never approved.
    for (const [agent, params] of [
      ["kimi", { modeId: "auto" }],
      ["mystery", {}],
    ] as const) {
      const id = await start(agent);
      if (agent === "kimi") await sent(id); // full access first
      await sent(id, params);
      await fixture.assistant(id, { finished: false, question: "plain" });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(await answered(id), undefined, agent);
      assert.equal((await adapter.interactions(id)).length, 1, agent);
      // The request needs the consumer: it is announced with the identity that
      // lody.interactions.respond takes, and says nothing will answer it.
      const pending = events.find(
        (e) => e.threadId === id && e.nativeType === "lody.interaction.pending",
      );
      assert.equal(pending.native.requestId, "plain1", agent);
      assert.equal(pending.native.agenvo.turnId, "assistant1", agent);
      assert.equal(pending.native.agenvo.permissionHandling, "explicit", agent);
      assert.equal(
        pending.native.permissionRequest.options[0].optionId,
        "allow",
      );
    }
  },
);

test(
  "Lody steer: a provider that cannot steer has its input requeued by Lody and the result says so",
  { timeout: 30000 },
  async (t) => {
    const { adapter, start } = await setup(t);
    const id = await start("mystery");
    const requeued = await adapter.call("lody.sessions.steer", {
      sessionId: id,
      text: "late",
      expectedTurnId: "unsupported",
    });
    assert.equal(requeued.error, undefined, JSON.stringify(requeued));
    const result = requeued.result as any;
    assert.equal(result.confirmation, "native_steer_requeued");
    assert.equal(result.disposition, "unsupported");
    assert.equal(result.recoveryOwned, true);
    // A refusal without native recovery stays unknown, never "requeued".
    const stale = await adapter.call("lody.sessions.steer", {
      sessionId: id,
      text: "late",
      expectedTurnId: "other",
    });
    assert.equal(stale.execution, "unknown");
    assert.equal(stale.error?.code, "native_steer_not_applied");
  },
);
