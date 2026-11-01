import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { binary } from "@agenvo/connector/cli/binary";
import { isolatedEnvironment } from "../support/environment.js";

// Test-owned core: a private session, state and endpoint; never the user's core.
export async function herdrFixture(root: string) {
  const executable = await binary("hc", {});
  const session = `test${process.pid}${Math.random().toString(36).slice(2, 8)}`;
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\agenvo-${session}`
      : join(root, "core.sock");
  const env = {
    ...isolatedEnvironment(root),
    HC_SESSION: session,
    HC_SOCKET: endpoint,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_RUNTIME_DIR: join(root, "run"),
    HC_SETTLE_MS: "0",
  };
  const exec = promisify(execFile);
  const command = (args: string[]) =>
    exec(executable, args, {
      env,
      cwd: root,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
  let started = false;
  return {
    endpoint,
    command,
    async start() {
      await mkdir(root, { recursive: true });
      await command(["server", "start"]);
      started = true;
    },
    async stop() {
      if (!started) return;
      await command(["server", "stop"]);
      started = false;
    },
  };
}
