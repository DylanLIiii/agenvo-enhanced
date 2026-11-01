import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { socketTempDir } from "../support/environment.js";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { Fault } from "@agenvo/protocol";

test("Herdr Core distinguishes native rejection from uncertain writes", async (t) => {
  const root = await mkdtemp(join(socketTempDir(), "hc-rpc-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\agenvo-rpc-${process.pid}`
      : join(root, "rpc.sock");
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data;
      if (!buffer.includes("\n")) return;
      const call = JSON.parse(buffer);
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
});
