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
    await fixture.assistant("external1", { finished: false });
    const turn = await until(
      async () =>
        events.find(
          (e) => e.nativeType === "history.updated" && e.native.turn.id,
        ),
      Boolean,
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
      Boolean,
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
      Boolean,
    );
    assert.equal(lost.native.scope, "session");
    assert.equal(lost.native.sessionId, ids[128]);
    const refused = await adapter.call("lody.sessions.history", {
      sessionId: ids[128],
    });
    assert.equal(refused.error?.code, "resource_exhausted");
  },
);
