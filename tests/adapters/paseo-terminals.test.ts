import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PaseoAdapter } from "../../apps/paseo/src/paseo.js";
import { nativePaseo } from "../support/paseo-native.js";
import { until } from "../support/environment.js";

test(
  "Paseo plain terminal input, capture, project registration and close",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ag-terminal-"));
    let closeAdapter = async () => {};
    let closeDaemon = async () => {};
    t.after(async () => {
      try {
        await closeAdapter();
      } finally {
        await closeDaemon();
        await rm(root, { recursive: true, force: true });
      }
    });
    const daemon = await nativePaseo(root);
    closeDaemon = daemon.close;
    const client = new DaemonClient({
      url: daemon.endpoint,
      clientId: crypto.randomUUID(),
      clientType: "cli",
      reconnect: { enabled: false },
    });
    await client.connect();
    const serverId = client.getLastServerInfoMessage()!.serverId;
    await client.close();
    const adapter = new PaseoAdapter({
      id: "paseo",
      kind: "paseo",
      label: "Isolated",
      endpoint: daemon.endpoint,
      serverId,
    });
    closeAdapter = () => adapter.close();
    await adapter.init();
    const call = async (method: string, input = {}) => {
      const outcome = await adapter.call(method, input);
      assert.equal(outcome.execution, "accepted", JSON.stringify(outcome));
      return outcome.result as any;
    };
    const registered = await call("paseo.projects.add", { cwd: root });
    assert.equal(registered.project.projectRootPath, root);
    const projects = await call("paseo.projects.list");
    assert.ok(JSON.stringify(projects).includes(registered.project.projectId));
    const created = await call("paseo.workspaces.create", {
      source: { kind: "directory", path: root },
    });
    const terminal = await call("paseo.terminals.create", {
      cwd: root,
      workspaceId: created.workspace.id,
      name: "plain-shell",
    });
    const terminalId = terminal.terminal.id;
    assert.equal(typeof terminalId, "string");
    assert.ok(
      JSON.stringify(
        await call("paseo.terminals.list", {
          workspaceId: created.workspace.id,
        }),
      ).includes(terminalId),
    );
    await call("paseo.terminals.send-text", {
      terminalId,
      text: `"${process.execPath}" -e "console.log('AG_TERMINAL'+'_ok')"`,
    });
    await call("paseo.terminals.send-keys", {
      terminalId,
      keys: [{ key: "Enter" }],
    });
    await until(
      async () =>
        JSON.stringify(
          await call("paseo.terminals.read", { terminalId, start: 0, end: 20 }),
        ),
      (output) => output.includes("AG_TERMINAL_ok"),
    );
    const invalid = await adapter.call("paseo.terminals.send-keys", {
      terminalId,
      keys: [{ key: "unknown-key" }],
    });
    assert.equal(invalid.error?.code, "invalid_params");
    await call("paseo.terminals.run", {
      terminalId,
      command: `"${process.execPath}" -e "console.log('AG_RUN'+'_ok')"`,
    });
    await until(
      async () =>
        JSON.stringify(
          await call("paseo.terminals.read", { terminalId, start: 0, end: 20 }),
        ),
      (output) => output.includes("AG_RUN_ok"),
    );
    for (const mode of [
      { name: "NORMAL", sequence: "[?1l", input: {}, expected: "1b5b41" },
      {
        name: "APPLICATION",
        sequence: "[?1h",
        input: { inputMode: { applicationCursorKeys: true } },
        expected: "1b4f41",
      },
    ]) {
      await call("paseo.terminals.run", {
        terminalId,
        command: `"${process.execPath}" -e "process.stdin.setRawMode(true);process.stdout.write(String.fromCharCode(27)+'${mode.sequence}'+['MODE','${mode.name}','READY'].join('_'));process.stdin.once('data',b=>{process.stdout.write('KEY_${mode.name}='+b.toString('hex')+String.fromCharCode(27)+'[?1l');process.exit()})"`,
      });
      await until(
        async () =>
          JSON.stringify(
            await call("paseo.terminals.read", {
              terminalId,
              start: 0,
              end: 80,
            }),
          ),
        (output) => output.includes(`MODE_${mode.name}_READY`),
      );
      // A new connection must encode its first key from the caller's choice,
      // without relying on observations from before the application started.
      await adapter.close();
      await adapter.init();
      await call("paseo.terminals.send-keys", {
        terminalId,
        keys: [{ key: "ArrowUp" }],
        ...mode.input,
      });
      const keyOutput = await until(
        async () =>
          JSON.stringify(
            await call("paseo.terminals.read", {
              terminalId,
              start: 0,
              end: 80,
            }),
          ),
        (output) => new RegExp(`KEY_${mode.name}=[0-9a-f]+`).test(output),
      );
      assert.ok(
        keyOutput.includes(`KEY_${mode.name}=${mode.expected}`),
        keyOutput,
      );
    }
    await call("paseo.terminals.close", { terminalId });
    assert.ok(
      !JSON.stringify(
        await call("paseo.terminals.list", {
          workspaceId: created.workspace.id,
        }),
      ).includes(terminalId),
    );
  },
);
