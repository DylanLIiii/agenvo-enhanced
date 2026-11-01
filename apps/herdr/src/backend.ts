import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { Fault } from "@agenvo/protocol";
import type { Backend } from "@agenvo/connector/backend";
import { instanceConfigSchema, type HerdrConfig } from "./config.js";
import { HerdrAdapter } from "./herdr.js";

export const backend: Backend<HerdrConfig> = {
  name: "herdr",
  command: "agenvo-herdr",
  schema: instanceConfigSchema,
  options: ["endpoint"],
  help: "[--endpoint PATH] (connects to an independently running Herdr Core socket or Windows named pipe)",
  revision: () => "herdr-core-0.1.15-native-v2",
  async configure(options) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "Herdr Core runs independently; configure --endpoint.",
      );
    const runtime = `/run/user/${process.getuid?.()}`;
    const endpoint =
      options.endpoint ??
      (process.platform === "win32"
        ? `\\\\.\\pipe\\herdr-core-${(process.env.USERNAME ?? "").replace(/[^a-zA-Z0-9]/g, "")}-default.sock`
        : process.env.XDG_RUNTIME_DIR
          ? resolve(process.env.XDG_RUNTIME_DIR, "herdr-core/default.sock")
          : existsSync(runtime)
            ? join(runtime, "herdr-core/default.sock")
            : resolve(
                process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
                "herdr-core/default/default.sock",
              ));
    return instanceConfigSchema.parse({
      id: options.id,
      label: options.label ?? options.id,
      kind: "herdr",
      endpoint,
    });
  },
  async create(config) {
    const adapter = new HerdrAdapter(config);
    await adapter.init().catch(() => {});
    return adapter;
  },
  async doctor(config) {
    const adapter = new HerdrAdapter(config);
    try {
      await adapter.init();
      return [
        { check: config.id + ":connection", ok: true, detail: adapter.version },
      ];
    } catch {
      return [
        {
          check: config.id + ":connection",
          ok: false,
          detail:
            "Start Herdr Core independently and check its configured endpoint.",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
