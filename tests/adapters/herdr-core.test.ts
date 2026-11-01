import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { descriptor } from "@agenvo/connector/config";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { CallDispatcher } from "../../packages/connector/src/dispatch.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { socketTempDir, until } from "../support/environment.js";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { Fault } from "@agenvo/protocol";

test("Herdr Core distinguishes native rejection from uncertain writes", async (t) => {
  const root = await mkdtemp(join(socketTempDir(), "hc-rpc-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\agenvo-rpc-${process.pid}`
      : join(root, "rpc.sock");
  const server = createServer((socket) => {
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const call = JSON.parse(buffer);
      if (call.params?.terminal === "oversized")
        return socket.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: "x".repeat(17 * 1024 * 1024),
          }) + "\n",
        );
      if (call.params?.terminal === "lost") return socket.destroy();
      const kind =
        call.params?.terminal === "blocked" ? "blocked" : "unavailable";
      socket.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32000, message: kind, data: { kind } },
        }) + "\n",
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const adapter = new HerdrAdapter({
    kind: "herdr",
    id: "test",
    label: "Test",
    endpoint,
  });
  t.after(async () => {
    await adapter.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const outcome = async (method: string, terminal: string) => {
    try {
      return await adapter.call(method, {
        terminal,
        ...(method === "terminal.send" ? { text: "hello" } : {}),
      });
    } catch (e) {
      if (e instanceof Fault) return e.outcome();
      throw e;
    }
  };
  assert.equal(
    (await outcome("terminal.send", "blocked")).execution,
    "rejected",
  );
  assert.equal((await outcome("terminal.send", "remote")).execution, "unknown");
  assert.equal((await outcome("terminal.send", "lost")).execution, "unknown");
  assert.equal((await outcome("terminal.get", "remote")).execution, "rejected");
  for (const method of ["terminal.get", "terminal.send"]) {
    const result = await outcome(method, "oversized");
    assert.equal(result.error?.code, "result_too_large");
    assert.equal(
      result.execution,
      method === "terminal.get" ? "rejected" : "unknown",
    );
  }
});

for (const mode of ["large snapshot", "subscription rejection"] as const) {
  test(
    `Herdr Core permits ordinary calls after ${mode}`,
    { timeout: 10000 },
    async (t) => {
      const root = await mkdtemp(join(socketTempDir(), "hc-events-"));
      const endpoint =
        process.platform === "win32"
          ? `\\\\.\\pipe\\agenvo-events-${process.pid}-${mode.replaceAll(" ", "-")}`
          : join(root, "rpc.sock");
      const sockets = new Set<Socket>();
      let subscriptions = 0;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        let buffer = "";
        socket.on("data", (data) => {
          buffer += data;
          if (!buffer.includes("\n")) return;
          const call = JSON.parse(buffer);
          const reply = (result: unknown) =>
            JSON.stringify({ jsonrpc: "2.0", id: call.id, result }) + "\n";
          if (call.method === "hello") {
            socket.end(reply({ generation: 1, version: "0.1.15" }));
          } else if (call.method === "events.subscribe") {
            subscriptions++;
            if (mode === "subscription rejection") {
              socket.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: call.id,
                  error: {
                    code: -32000,
                    message: "unavailable",
                    data: { kind: "unavailable" },
                  },
                }) + "\n",
              );
            } else {
              socket.write(
                reply({
                  seq: 1,
                  terminals: Array.from({ length: 1200 }, (_, i) => ({
                    address: `t${i}`,
                    title: "x".repeat(1024),
                  })),
                }),
              );
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "event",
                  params: {
                    seq: 2,
                    type: "status",
                    terminal: "t7",
                    data: { status: { state: "idle" } },
                  },
                }) + "\n",
              );
            }
          } else {
            socket.end(reply({ address: "t7", state: "live" }));
          }
        });
      });
      const adapter = new HerdrAdapter({
        kind: "herdr",
        id: "test",
        label: "Test",
        endpoint,
      });
      t.after(async () => {
        await adapter.close();
        for (const socket of sockets) socket.destroy();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        await rm(root, { recursive: true, force: true });
      });
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      await adapter.init();
      const instance = await descriptor(
        adapter.config,
        adapter.available,
        adapter.version,
        "test",
      );
      const dispatcher = new CallDispatcher(
        new Map([["test", adapter]]),
        new Map([["test", instance]]),
      );
      const received: RuntimeEvent[] = [];
      adapter.watchEvents((event) => received.push(event));
      await until(
        () => received,
        (events) => events.length > 0,
      );
      if (mode === "large snapshot") {
        await until(
          () => received,
          (events) => events.some((event) => event.nativeType === "status"),
          1000,
        );
      } else {
        await until(
          () => subscriptions,
          (count) => count >= 3,
        );
        assert.equal(
          received.filter(
            (event) => event.nativeType === "agenvo.resync_required",
          ).length,
          1,
        );
      }
      const result = await dispatcher.call(
        {
          v: 1,
          type: "call",
          requestId: "small",
          instanceId: "test",
          fingerprint: instance.fingerprint,
          method: "terminal.get",
          params: { terminal: "t7" },
        },
        "{}",
        new Set(),
      );
      assert.equal(result.execution, "accepted");
      assert.deepEqual(result.result, { address: "t7", state: "live" });
    },
  );
}
