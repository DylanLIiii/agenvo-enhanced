import test from "node:test";
import assert from "node:assert/strict";
import { lodyCloudFixture } from "./fixtures/lody-cloud.js";
import { LodyAdapter } from "../apps/lody/src/lody.js";
import { observation } from "../apps/lody/src/workspace.js";
import { until } from "./support/environment.js";

async function setStatus(
  fixture: Awaited<ReturnType<typeof lodyCloudFixture>>,
  id: string,
  type: string,
) {
  await fixture.repo.upsertDocMeta(`session-${id}`, { status: { type } });
}

test(
  "Lody observes active Sessions without a subscribe call, releases quiet ones, and resumes after reconnect",
  { timeout: 40000 },
  async (t) => {
    const grace = observation.graceMs;
    observation.graceMs = 300;
    t.after(() => {
      observation.graceMs = grace;
    });
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const observed = () =>
      (adapter.connected() as any).docs.get("external1")?.observed;

    // The removed method is gone from the tool surface.
    assert.equal(
      (
        await adapter.call("lody.sessions.subscribe", {
          sessionId: "external1",
        })
      ).error?.code,
      "unsupported_capability",
    );
    // Nothing is open for a quiet Session, and no call is needed once it runs.
    assert.equal(observed(), undefined);
    await setStatus(fixture, "external1", "running");
    await until(async () => observed(), Boolean);
    // Changes that land before the document finished opening are part of its
    // initial snapshot, not events; wait until it is open.
    await (adapter.connected() as any).docs.get("external1").opened;
    await fixture.assistant("external1", { finished: false });
    const turn = await until(
      async () =>
        events.find(
          (e) => e.nativeType === "history.updated" && e.native.turn.id,
        ),
      (value) => Boolean(value),
    );
    assert.equal(turn.native.agenvo.agentConfigId, "config1");

    // Returning to idle releases the observation after the grace period.
    await setStatus(fixture, "external1", "idle");
    await until(
      async () => observed(),
      (value) => value === false,
    );

    // After a reconnect an active Session is observed again without a call.
    await setStatus(fixture, "external1", "running");
    await until(async () => observed(), Boolean);
    fixture.setOnline(false);
    await until(
      async () => adapter.available,
      (value) => !value,
    );
    fixture.setOnline(true);
    await until(
      async () => adapter.available,
      (value) => value,
      15000,
    );
    assert.ok(
      events.some(
        (e) =>
          e.nativeType === "agenvo.resync_required" &&
          e.native.scope === "workspace",
      ),
    );
    await until(async () => observed(), Boolean, 10000);
    const before = events.length;
    const { doc, room } = await fixture.document("external1");
    doc
      .getList("history")
      .pushContainer(new (await import("loro-crdt")).LoroMap());
    const row: any = doc
      .getList("history")
      .get(doc.getList("history").length - 1);
    row.set("id", "assistant2");
    row.set("role", "assistant");
    row.set("finished", true);
    doc.commit();
    await room.subscription("fixture").waitUntilSynced();
    await until(
      async () =>
        events
          .slice(before)
          .find(
            (e) =>
              e.nativeType === "history.updated" &&
              e.native.turn.id === "assistant2",
          ),
      (value) => Boolean(value),
      10000,
    );
  },
);

test(
  "Lody reads do not consume the document capacity; only active Sessions are held and capacity loss is reported",
  { timeout: 120000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const ids: string[] = [];
    // Creation writes metadata and an empty document; no document stays open.
    for (let i = 0; i < 129; i++)
      ids.push(
        (
          (await adapter.call("lody.sessions.create", {
            machineId: "machine1",
            agentConfigId: "config1",
          })) as any
        ).result.session.id,
      );
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const open = () => (adapter.connected() as any).docs.size;
    // 130 Sessions are read one after another; reads never exhaust the cap.
    for (const item of ids) {
      const read = await adapter.call("lody.sessions.history", {
        sessionId: item,
      });
      assert.equal(read.error, undefined, item);
      assert.ok(open() <= 128);
    }
    // 128 active Sessions are held; the 129th cannot be, and says so.
    for (let i = 0; i < 128; i++) await setStatus(fixture, ids[i], "running");
    await until(
      async () =>
        [...(adapter.connected() as any).docs.values()].filter(
          (d: any) => d.observed,
        ).length,
      (n) => n === 128,
      30000,
    );
    await setStatus(fixture, ids[128], "running");
    const lost = await until(
      async () =>
        events.find(
          (e) =>
            e.nativeType === "agenvo.resync_required" &&
            e.native.reason === "observation_capacity",
        ),
      (value) => Boolean(value),
    );
    assert.equal(lost.native.scope, "session");
    assert.equal(lost.native.sessionId, ids[128]);
    const refused = await adapter.call("lody.sessions.history", {
      sessionId: ids[128],
    });
    assert.equal(refused.error?.code, "resource_exhausted");
  },
);

test(
  "Lody announces a request that needs the consumer after a reconnect instead of leaving it stalled, and reports who resolved it",
  { timeout: 40000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const observed = () =>
      (adapter.connected() as any).docs.get("external1")?.observed;
    // A full-access turn: this Connector process owns automatic approval.
    const sent = await adapter.call("lody.sessions.send", {
      sessionId: "external1",
      text: "Run unattended",
    });
    assert.equal(sent.error, undefined);
    await setStatus(fixture, "external1", "running");
    await until(async () => observed(), Boolean);
    fixture.setOnline(false);
    await until(
      async () => adapter.available,
      (value) => !value,
    );
    fixture.setOnline(true);
    await until(
      async () => adapter.available,
      (value) => value,
      15000,
    );
    await until(async () => observed(), Boolean, 10000);

    // The policy is not known after the reconnect, so nothing approves for the
    // consumer; the request is announced with that fact.
    await fixture.assistant("external1", {
      finished: false,
      question: "plain",
    });
    const pending = await until(
      async () =>
        events.find((e) => e.nativeType === "lody.interaction.pending"),
      (value) => Boolean(value),
      10000,
    );
    assert.equal(pending.native.agenvo.permissionHandling, "unknown");
    assert.equal(pending.native.requestId, "plain1");
    assert.equal(pending.native.agenvo.turnId, "assistant1");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await adapter.interactions("external1")).length, 1);

    // Another client answers: the event says so without naming a resolver.
    const { doc, room } = await fixture.document("external1");
    const row: any = doc.getList("history").get(1);
    row
      .get("items")
      .get(1)
      .get("permissionRequest")
      .set("outcome", { outcome: "selected", optionId: "allow" });
    doc.commit();
    await room.subscription("fixture").waitUntilSynced();
    const resolved = await until(
      async () =>
        events.find((e) => e.nativeType === "lody.interaction.resolved"),
      (value) => Boolean(value),
      10000,
    );
    assert.equal(resolved.native.requestId, "plain1");
    assert.equal(resolved.native.outcome.optionId, "allow");
    assert.equal(resolved.native.resolvedBy, undefined);
    assert.equal(resolved.native.agenvo.turnId, "assistant1");
  },
);

test(
  "Lody keeps an oversized request announceable with its identity and the call that reads it",
  { timeout: 30000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    await setStatus(fixture, "external1", "running");
    await until(
      async () => (adapter.connected() as any).docs.get("external1")?.observed,
      (value) => Boolean(value),
    );
    await fixture.assistant("external1", {
      finished: false,
      question: true,
      padding: 40000,
    });
    const pending = await until(
      async () =>
        events.find(
          (e) =>
            e.nativeType === "lody.interaction.pending" && e.native.truncated,
        ),
      (value) => Boolean(value),
      10000,
    );
    assert.equal(pending.native.requestId, "question1");
    assert.equal(pending.native.turnId, "assistant1");
    assert.equal(
      pending.native.permissionRequest.options[0].optionId,
      "answer",
    );
    assert.equal(pending.native.permissionRequest.hasMeta, true);
    assert.deepEqual(pending.native.agenvo.read, {
      method: "lody.interactions.list",
      sessionId: "external1",
    });
  },
);

test(
  "Lody announces a published capability row once, so a selection rejected earlier can be retried",
  { timeout: 40000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    const published = () =>
      events.filter((e) => e.nativeType === "lody.capability.published");
    const machine = await fixture.repo.openFlockDoc("workspace1:mf:machine1");
    const room = await fixture.repo.joinFlockDocRoom("workspace1:mf:machine1");
    const publish = async (id: string, value: unknown) => {
      machine.flock.set(["acpCapability", id], value as any);
      machine.flock.commit();
      await room.subscription("fixture").waitUntilSynced();
    };
    machine.flock.set(["agentConfig", "config2"], {
      id: "config2",
      machineId: "machine1",
      name: "Second",
      cliType: "builtin",
      agentType: "codex",
    });
    machine.flock.commit();
    await room.subscription("fixture").waitUntilSynced();

    // Another machine is watched once this connection opens it (cloud mode).
    await adapter.call("lody.catalog", { machineId: "machine1" });
    // The row that existed already is not announced.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(published().length, 0);

    const created = (await adapter.call("lody.sessions.create", {
      machineId: "machine1",
      agentConfigId: "config2",
    })) as any;
    const rejected = await adapter.call("lody.sessions.send", {
      sessionId: created.result.session.id,
      text: "Pick a mode",
      modeId: "yolo",
    });
    assert.equal(rejected.error?.code, "unsupported_capability");

    await publish("config2", { modes: [{ id: "yolo", name: "Yolo" }] });
    const event = await until(
      async () => published()[0],
      (value) => Boolean(value),
    );
    assert.equal(event.threadId, undefined);
    assert.equal(event.native.agenvo.agentConfigId, "config2");
    assert.equal(event.native.agenvo.machineId, "machine1");
    assert.equal(event.native.agenvo.agentType, "codex");
    assert.equal(event.native.agenvo.read.method, "lody.catalog");
    assert.equal(event.native.capability.modes[0].id, "yolo");
    const retried = await adapter.call("lody.sessions.send", {
      sessionId: created.result.session.id,
      text: "Pick a mode",
      modeId: "yolo",
    });
    assert.equal(retried.error, undefined, JSON.stringify(retried));

    // The same content again is not news; a changed row is.
    await publish("config2", { modes: [{ id: "yolo", name: "Yolo" }] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(published().length, 1);
    await publish("config2", {
      modes: [
        { id: "yolo", name: "Yolo" },
        { id: "plan", name: "Plan" },
      ],
    });
    await until(
      async () => published().length,
      (n) => n === 2,
    );
  },
);

test(
  "Lody history can continue after a known turn, deterministically and independent of earlier cursors",
  { timeout: 40000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const sent: string[] = [];
    for (let i = 0; i < 3; i++)
      sent.push(
        (
          (await adapter.call("lody.sessions.send", {
            sessionId: "external1",
            text: `Input ${i}`,
          })) as any
        ).result.userTurnId,
      );
    const read = async (params: Record<string, unknown>) =>
      (await adapter.call("lody.sessions.history", {
        sessionId: "external1",
        ...params,
      })) as any;
    const ids = (r: any) => r.result.items.map((i: any) => i.id);
    assert.deepEqual(ids(await read({})), sent);

    const second = await read({ afterTurnId: sent[0], limit: 1 });
    assert.deepEqual(ids(second), [sent[1]]);
    assert.deepEqual(ids(await read({ cursor: second.result.nextCursor })), [
      sent[2],
    ]);
    // After the newest turn there is nothing, and no cursor.
    const none = await read({ afterTurnId: sent[2] });
    assert.deepEqual(ids(none), []);
    assert.equal(none.result.nextCursor, undefined);
    assert.equal(
      (await read({ afterTurnId: "no-such-turn" })).error?.code,
      "not_found",
    );
    assert.equal(
      (await read({ afterTurnId: sent[0], cursor: second.result.nextCursor }))
        .error?.code,
      "invalid_params",
    );

    // A native edit that moves turns invalidates the old cursor, while the
    // turn identity still names the same place.
    const { doc, room } = await fixture.document("external1");
    doc.getList("history").delete(0, 1);
    doc.commit();
    await room.subscription("fixture").waitUntilSynced();
    await until(
      async () => ids(await read({ afterTurnId: sent[1] })),
      (found) => found.length === 1 && found[0] === sent[2],
    );
    assert.equal(
      (await read({ cursor: second.result.nextCursor })).error?.code,
      "invalid_cursor",
    );
    assert.equal(
      (await read({ afterTurnId: sent[0] })).error?.code,
      "not_found",
    );
  },
);

test(
  "Lody reports a response once and attributes it even when the native side reacts before the upload is confirmed",
  { timeout: 30000 },
  async (t) => {
    const fixture = await lodyCloudFixture();
    t.after(() => fixture.close());
    const adapter = new LodyAdapter(fixture.config);
    t.after(() => adapter.close());
    await adapter.init();
    const events: any[] = [];
    adapter.watchEvents((event) => events.push(event));
    await setStatus(fixture, "external1", "running");
    await until(
      async () => (adapter.connected() as any).docs.get("external1")?.observed,
      (value) => Boolean(value),
    );
    const row: any = await fixture.assistant("external1", {
      finished: false,
      question: true,
    });
    await until(
      async () =>
        events.some((e) => e.nativeType === "lody.interaction.pending"),
      (value) => value,
    );
    const connection = adapter.connected().connection;
    const upload = connection.uploaded.bind(connection);
    connection.uploaded = async (room) => {
      // The native side finishes the turn while the upload is unconfirmed.
      row.set("finished", true);
      (await fixture.document("external1")).doc.commit();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return upload(room);
    };
    const answered = await adapter.call("lody.interactions.respond", {
      sessionId: "external1",
      turnId: "assistant1",
      requestId: "question1",
      outcome: { outcome: "selected", optionId: "answer" },
    });
    assert.equal(answered.error, undefined, JSON.stringify(answered));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const resolved = events.filter(
      (e) => e.nativeType === "lody.interaction.resolved",
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].native.resolvedBy, "agenvo_respond");
  },
);
