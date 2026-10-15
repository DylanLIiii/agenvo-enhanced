import test from "node:test";
import assert from "node:assert/strict";
import { PaseoAdapter } from "../apps/paseo/src/paseo.js";
import { paseoFixture } from "./fixtures/paseo-daemon.js";
import { until } from "./support/environment.js";

test("Paseo terminal keys use normal mode by default and accept native mode overrides", async (t) => {
  const fixture = await paseoFixture();
  t.after(() => fixture.close());
  const adapter = new PaseoAdapter({
    id: "paseo",
    label: "Paseo",
    kind: "paseo",
    endpoint: fixture.endpoint,
    serverId: fixture.serverId,
  });
  t.after(() => adapter.close());
  await adapter.init();
  const invalid = await adapter.call("paseo.terminals.send-keys", {
    terminalId: "terminal",
    keys: [{ key: "Enter" }, { key: "unknown-key" }],
  });
  assert.equal(invalid.error?.code, "invalid_params");
  // A correlated request drains earlier WebSocket messages before inspecting
  // whether rejected batches sent any prefix to the terminal.
  await adapter.call("paseo.agents.list", {});
  assert.equal(
    fixture.requests.some((p) => p.type === "terminal_input"),
    false,
  );
  for (const [params, expected] of [
    [{ keys: [{ key: "Enter" }, { key: "c", ctrl: true }] }, "\r\x03"],
    [{ keys: [{ key: "ArrowUp" }] }, "\x1b[A"],
    [{ keys: [{ key: "Enter", shift: true }] }, "\r"],
    [{ keys: [{ key: "ArrowUp" }], inputMode: {} }, "\x1b[A"],
    [
      {
        keys: [{ key: "ArrowUp" }],
        inputMode: { applicationCursorKeys: true },
      },
      "\x1bOA",
    ],
    [
      {
        keys: [{ key: "Enter", shift: true }],
        inputMode: { kittyKeyboardFlags: 1 },
      },
      "\x1b[13;2u",
    ],
    [
      {
        keys: [{ key: "Enter", shift: true }],
        inputMode: { win32InputMode: true },
      },
      "\x1b[13;28;13;1;16;1_",
    ],
  ] as const) {
    const result = await adapter.call("paseo.terminals.send-keys", {
      terminalId: "terminal",
      ...params,
    });
    assert.equal(result.execution, "accepted", JSON.stringify(result));
    await adapter.call("paseo.agents.list", {});
    assert.equal(
      fixture.requests.filter((p) => p.type === "terminal_input").at(-1).message
        .data,
      expected,
    );
  }
});

test("Paseo reconnect does not replay uncertain modern creation and retains its correlation key", async (t) => {
  const fixture = await paseoFixture(true);
  t.after(() => fixture.close());
  const adapter = new PaseoAdapter({
    id: "paseo",
    label: "Paseo",
    kind: "paseo",
    endpoint: fixture.endpoint,
    serverId: fixture.serverId,
  });
  t.after(() => adapter.close());
  await adapter.init();
  fixture.dropNextCreate();
  const result = await adapter.call("paseo.agents.create", {
    provider: "codex",
    cwd: "/fixture",
  });
  assert.equal(result.execution, "unknown");
  const native = result.error?.native as { idempotencyKey: string };
  assert.ok(native.idempotencyKey);
  await until(() => adapter.available, Boolean);
  const creates = fixture.requests.filter(
    (r) => r.type === "agent.create.request",
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0].idempotencyKey, native.idempotencyKey);
  assert.equal(
    fixture.agents.size,
    1,
    "the failed response does not imply creation failed",
  );
});

test("Paseo rejects a different daemon identity before subscribing", async (t) => {
  const fixture = await paseoFixture();
  t.after(() => fixture.close());
  const adapter = new PaseoAdapter({
    id: "paseo",
    label: "Paseo",
    kind: "paseo",
    endpoint: fixture.endpoint,
    serverId: "previous-daemon",
  });
  t.after(() => adapter.close());
  await assert.rejects(adapter.init(), { code: "daemon_identity_changed" });
  assert.equal(adapter.available, false);
  assert.equal(fixture.requests.length, 0);
});
