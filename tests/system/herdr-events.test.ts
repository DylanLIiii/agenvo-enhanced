import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";
import { callCode, nativeOutcome } from "../support/code.js";

test(
  "Herdr Core MCP discovers external terminals, exchanges input, and resumes after connector and core restart",
  { timeout: 90000 },
  async (t) => {
    const lab = await eventsLab(t);
    const native = await herdrFixture(join(lab.root, "hc"));
    await native.start();
    lab.cleanup(() => native.stop());
    const external = JSON.parse(
      (
        await native.command([
          "run",
          "--bg",
          "--name",
          "external",
          process.execPath,
          resolve("tests/fixtures/herdr-agent.mjs"),
        ])
      ).stdout,
    );
    const terminal = external.address;
    const config = {
      kind: "herdr" as const,
      id: "herdr",
      label: "Test Herdr Core",
      endpoint: native.endpoint,
    };
    const device = await lab.connect([config]);
    const call = (method: string, params = {}) =>
      lab.call(device, "herdr", method, params);
    for (const query of [
      "create work context",
      "submit input",
      "read output",
      "interrupt",
    ]) {
      const found = await lab.rpc("tools/call", {
        name: "search",
        arguments: {
          query,
          deviceId: device,
          instanceId: "herdr",
          includeSchema: true,
        },
      });
      assert.ok(JSON.parse(found.content[0].text).result.items.length, query);
    }
    const listed = await call("terminal.list");
    assert.ok(listed.terminals.some((item: any) => item.address === terminal));
    await until(
      () => call("terminal.read", { terminal }),
      (r) => r.text.includes("Fixture ready"),
    );
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "herdr", {
        serviceId: "default",
        threadId: terminal,
        nativeTypes: ["status"],
      }),
    );
    await until(
      () => call("terminal.get", { terminal }),
      (r) => r.status?.state === "idle",
    );
    await call("terminal.send", { terminal, text: "ask for a label" });
    await until(
      () => lab.received,
      (events) =>
        events.some(
          (e) =>
            e.data.nativeType === "status" &&
            e.data.native.data?.status?.state === "blocked",
        ),
    );
    const question = await call("terminal.read", { terminal });
    assert.match(question.text, /Which label should I use/);
    const refused = await lab.rpc("tools/call", {
      name: "execute",
      arguments: callCode({
        deviceId: device,
        instanceId: "herdr",
        method: "terminal.send",
        params: { terminal, text: "alpha" },
      }),
    });
    const rejection = nativeOutcome(refused);
    assert.equal(rejection.execution, "rejected");
    assert.equal(rejection.error.native.data.kind, "blocked");
    await call("terminal.send", { terminal, text: "alpha", force: true });
    await until(
      () => call("terminal.read", { terminal }),
      (r) => r.text.includes("Fixture result: alpha"),
    );
    await lab.restartConnector(device);
    await until(
      () => call("terminal.read", { terminal }).catch(() => null),
      (r) => !!r?.text?.includes("Fixture result: alpha"),
    );
    await call("terminal.send", { terminal, text: "beta" });
    await until(
      () => call("terminal.read", { terminal }),
      (r) => r.text.includes("Fixture result: beta"),
    );
    const before = lab.received.length;
    await native.command(["server", "restart"]);
    await until(
      () => lab.received.slice(before),
      (events) =>
        events.some((e) => e.data.nativeType === "agenvo.resync_required"),
      20000,
    );
    await until(
      () => call("terminal.read", { terminal }).catch(() => null),
      (r) => !!r?.text?.includes("Fixture result: beta"),
      20000,
    );
    const created = await call("terminal.run", {
      name: "created",
      argv: [process.execPath, resolve("tests/fixtures/herdr-agent.mjs")],
    });
    assert.equal(created.name, "created");
    await until(
      () => call("terminal.read", { terminal: created.address }),
      (r) => r.text.includes("Fixture ready"),
    );
    await call("terminal.send", { terminal: created.address, text: "gamma" });
    await until(
      () => call("terminal.read", { terminal: created.address }),
      (r) => r.text.includes("Fixture result: gamma"),
    );
    const status = await call("server.status");
    assert.match(status.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof status.pid, "number");
    assert.equal(typeof status.uptime_ms, "number");
    const file = join(lab.root, "native.txt");
    const written = await call("file.write", {
      path: file,
      data: Buffer.from("first\nsecond\n").toString("base64"),
    });
    assert.equal(written.path, file);
    const partial = await call("file.read", {
      path: file,
      offset: 2,
      limit: 1,
    });
    assert.equal(partial.text, "second\n");
    assert.equal(partial.lines, 2);
    await call("file.edit", {
      path: file,
      edits: [{ old: "second", new: "2nd" }],
    });
    assert.match(
      (await call("file.read", { path: file })).text,
      /^first\n2nd\n$/,
    );
    const failed = await lab.rpc("tools/call", {
      name: "execute",
      arguments: callCode({
        deviceId: device,
        instanceId: "herdr",
        method: "file.edit",
        params: { path: file, edits: [{ old: "missing", new: "x" }] },
      }),
    });
    const editMiss = nativeOutcome(failed);
    assert.equal(editMiss.execution, "rejected");
    assert.equal(editMiss.error.native.data.kind, "edit_failed");
    assert.match(
      (await call("file.read", { path: file })).text,
      /^first\n2nd\n$/,
    );
    const exec = await call("machine.exec", {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('hi');process.exit(3)",
      ],
    });
    assert.equal(exec.code, 3);
    assert.equal(Buffer.from(exec.stdout, "base64").toString(), "hi");
    const noMachine = await lab.rpc("tools/call", {
      name: "execute",
      arguments: callCode({
        deviceId: device,
        instanceId: "herdr",
        method: "machine.connect",
        params: { machine: "no-such-machine" },
      }),
    });
    const unknownMachine = nativeOutcome(noMachine);
    assert.equal(unknownMachine.execution, "rejected");
    assert.equal(unknownMachine.error.native.data.kind, "machine_unknown");
    await writeFile(file, "x".repeat(100000));
    const tooLarge = await lab.rpc("tools/call", {
      name: "execute",
      arguments: callCode({
        deviceId: device,
        instanceId: "herdr",
        method: "file.read",
        params: { path: file },
      }),
    });
    assert.equal(nativeOutcome(tooLarge).error.code, "result_too_large");
    const oversized = await lab.rpc("tools/call", {
      name: "execute",
      arguments: callCode({
        deviceId: device,
        instanceId: "herdr",
        method: "file.write",
        params: { path: file, data: "A".repeat(45001) },
      }),
    });
    assert.equal(nativeOutcome(oversized).error.code, "invalid_params");
  },
);
