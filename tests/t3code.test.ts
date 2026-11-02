import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "@agenvo/connector/adapters/adapter";
import { T3CodeAdapter } from "../apps/t3code/src/t3code.js";
import { login } from "../apps/t3code/src/login.js";
import {
  instanceConfigSchema,
  readToken,
  tokenPath,
  writeToken,
} from "../apps/t3code/src/config.js";
import { backend } from "../apps/t3code/src/backend.js";
import { t3codeFixture } from "./fixtures/t3code-server.js";

async function setup(
  t: test.TestContext,
  options: { pageSize?: number; repeatCursor?: boolean } = {},
) {
  const server = await t3codeFixture(options);
  const dir = await mkdtemp(join(tmpdir(), "agenvo-t3code-"));
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = instanceConfigSchema.parse({
    id: "t3",
    label: "T3 Code",
    kind: "t3code",
    endpoint: server.endpoint,
    tokenFile: join(dir, "tokens", "t3.json"),
  });
  return { server, dir, config };
}

test("T3 Code sign-in uses native MCP OAuth with PKCE and stores a private token", async (t) => {
  const { server, config } = await setup(t);
  const announced: string[] = [];
  const result = await login(config, {
    browser: false,
    // The fixture approves at once and redirects to the loopback callback.
    announce: (url) => {
      announced.push(url);
      void fetch(url);
    },
  });
  assert.match(announced[0], /code_challenge_method=S256/);
  assert.match(announced[0], /resource=/);
  assert.equal(result.expiresIn, 2592000);
  const info = await stat(config.tokenFile);
  if (process.platform !== "win32") assert.equal(info.mode & 0o777, 0o600);
  const token = await readToken(config);
  assert.match(token.accessToken, /^token-/);
  assert.ok(token.expiresAt! > Date.now());
  const adapter = new T3CodeAdapter(config);
  t.after(() => adapter.close());
  await adapter.init();
  assert.equal(adapter.version, "9.9.9-fixture");
  assert.equal(server.calls.length, 0);
});

test("T3 Code initialization joins an active connection and does not reconnect when available", async (t) => {
  const { server, config } = await setup(t);
  await writeToken(config, { accessToken: server.issue(), clientId: "c" });
  const adapter = new T3CodeAdapter(config);
  t.after(() => adapter.close());
  await Promise.all([adapter.init(), adapter.init()]);
  assert.equal(server.initializations, 1);
  await adapter.init();
  assert.equal(server.initializations, 1);
});

test("T3 Code uses portable token filenames for the shared instance ID syntax", () => {
  const ids = ["t3", "CON", "test:one", "test.two", "x" + ":".repeat(127)];
  const paths = ids.map((id) => tokenPath("/config", id));
  assert.equal(new Set(paths).size, ids.length);
  for (const path of paths) {
    const filename = path.split(/[\\/]/).pop()!;
    assert.match(filename, /^instance-[A-Za-z0-9_-]+\.json$/);
    assert.ok(filename.length < 255);
  }
});

test("T3 Code tokens are refused when missing, expired or readable by others", async (t) => {
  const { config } = await setup(t);
  await assert.rejects(readToken(config), { code: "native_unauthorized" });
  await writeToken(config, {
    accessToken: "x",
    clientId: "c",
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(readToken(config), { code: "native_unauthorized" });
  if (process.platform !== "win32") {
    await writeToken(config, { accessToken: "x", clientId: "c" });
    await chmod(config.tokenFile, 0o644);
    await assert.rejects(readToken(config), { code: "insecure_credentials" });
  }
  assert.equal((await backend.doctor(config))[0].ok, false);
});

test("T3 Code exposes only orchestration tools with native schemas and shared discovery terms", async (t) => {
  const { server, config } = await setup(t);
  await writeToken(config, { accessToken: server.issue(), clientId: "c" });
  const adapter = new T3CodeAdapter(config);
  t.after(() => adapter.close());
  await adapter.init();
  const names = adapter.methods().map((m) => m.name);
  for (const hidden of ["preview_open", "delegate_task", "html_render"])
    assert.ok(!names.includes(hidden), hidden);
  assert.ok(names.includes("t3_thread_launch"));
  const byName = Object.fromEntries(adapter.methods().map((m) => [m.name, m]));
  assert.equal(byName.t3_thread_list.readOnly, true);
  assert.equal(byName.t3_thread_send.readOnly, false);
  assert.deepEqual(byName.t3_thread_send.inputSchema.required, [
    "threadId",
    "message",
  ]);
  assert.match(byName.t3_thread_send.description, /Native: Fixture/);
  const find = (query: string) =>
    describe(adapter, { query }).items.map((m: any) => m.name);
  for (const [query, method] of [
    ["create work context", "t3_thread_launch"],
    ["submit input", "t3_thread_send"],
    ["read output", "t3_thread_read"],
    ["interrupt", "t3_thread_interrupt"],
    ["respond", "t3_pending_request"],
  ])
    assert.ok(find(query).includes(method), query);
  assert.equal((await backend.doctor(config))[0].ok, true);
});

test("T3 Code discovers every native catalog page and rejects a repeated cursor", async (t) => {
  const { server, config } = await setup(t, { pageSize: 3 });
  await writeToken(config, { accessToken: server.issue(), clientId: "c" });
  const adapter = new T3CodeAdapter(config);
  t.after(() => adapter.close());
  await adapter.init();
  assert.deepEqual(server.listCursors, [undefined, "3", "6", "9"]);
  assert.ok(adapter.methods().some((m) => m.name === "t3_pending_request"));
  assert.ok(!adapter.methods().some((m) => m.name === "html_render"));

  const repeating = await setup(t, { pageSize: 3, repeatCursor: true });
  await writeToken(repeating.config, {
    accessToken: repeating.server.issue(),
    clientId: "c",
  });
  const invalid = new T3CodeAdapter(repeating.config);
  t.after(() => invalid.close());
  await assert.rejects(invalid.init(), {
    code: "native_error",
    message: "T3 Code repeated a tools/list cursor",
  });
  assert.deepEqual(repeating.server.listCursors, [undefined, "3"]);
});

test("T3 Code calls keep native results and errors and never replay ambiguous writes", async (t) => {
  const { server, config } = await setup(t);
  await writeToken(config, { accessToken: server.issue(), clientId: "c" });
  const adapter = new T3CodeAdapter(config);
  t.after(() => adapter.close());
  await adapter.init();

  const list = await adapter.call("t3_thread_list", { projectId: "project-1" });
  assert.equal(list.execution, "accepted");
  assert.equal((list.result as any).threads[0].threadId, "thread-external");

  const launched = await adapter.call("t3_thread_launch", {
    title: "From Agenvo",
    projectId: "project-1",
    message: "Do it",
  });
  assert.equal(launched.execution, "accepted");
  assert.ok(launched.nativeIds?.threadId);

  const missing = await adapter.call("t3_thread_send", {
    threadId: "thread-missing",
    message: "Hello",
  });
  assert.equal(missing.execution, "rejected");
  assert.equal(missing.error?.message, "Fixture target not found");
  assert.equal(missing.nativeIds?.threadId, "thread-missing");

  server.resultForNextCall({
    isError: true,
    content: [{ type: "text", text: "Native error" }],
    structuredContent: { detail: "x".repeat(100000) },
  });
  const oversized = await adapter.call("t3_thread_send", {
    threadId: "thread-external",
    message: "x",
  });
  assert.equal(oversized.execution, "rejected");
  assert.equal(oversized.error?.code, "result_too_large");
  assert.equal(oversized.nativeIds?.threadId, "thread-external");

  server.rejectNextCall();
  const invalid = await adapter.call("t3_thread_send", {
    threadId: "thread-external",
    message: 1,
  });
  assert.equal(invalid.execution, "rejected");

  await assert.rejects(adapter.call("preview_open", {}), {
    code: "unknown_method",
  });
  await assert.rejects(adapter.call("t3_queue", { action: "list" }), {
    code: "unknown_method",
  });

  const before = server.calls.filter((c) => c.name === "t3_thread_send").length;
  server.dropNextCall();
  const lost = await adapter.call("t3_thread_send", {
    threadId: "thread-external",
    message: "Only once",
  });
  assert.equal(lost.execution, "unknown");
  assert.equal(lost.nativeIds?.threadId, "thread-external");
  assert.equal(
    server.calls.filter((c) => c.name === "t3_thread_send").length,
    before + 1,
  );
  assert.equal(adapter.available, false);
  await assert.rejects(adapter.call("t3_thread_list", {}), {
    code: "runtime_unavailable",
  });

  await adapter.init();
  server.dropNextCall();
  const lostRead = await adapter.call("t3_thread_list", {});
  assert.equal(lostRead.execution, "not_started");
});

test("T3 Code revocation and environment restarts change availability without replay", async (t) => {
  const { server, config } = await setup(t);
  await writeToken(config, { accessToken: server.issue(), clientId: "c" });
  const adapter = new T3CodeAdapter(config);
  t.after(() => adapter.close());
  let changes = 0;
  adapter.onAvailabilityChange = () => changes++;
  await adapter.init();
  assert.equal(adapter.available, true);

  server.forgetSessions();
  const stale = await adapter.call("t3_thread_list", {});
  assert.equal(stale.execution, "not_started");
  assert.equal(adapter.available, false);
  await adapter.init();
  assert.equal(adapter.available, true);
  assert.equal(
    (await adapter.call("t3_thread_list", {})).execution,
    "accepted",
  );

  server.revokeAll();
  const refused = await adapter.call("t3_thread_send", {
    threadId: "thread-external",
    message: "Refused",
  });
  assert.equal(refused.error?.code, "native_unauthorized");
  assert.equal(adapter.available, false);
  await assert.rejects(adapter.init(), { code: "native_unauthorized" });
  assert.ok(changes >= 3);
});
