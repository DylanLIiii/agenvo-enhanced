import { Fault, identifier } from "@agenvo/protocol";
import type { Backend, Options } from "@agenvo/connector/backend";
import {
  instanceConfigSchema,
  executionPolicy,
  tokenPath,
  type T3CodeConfig,
} from "./config.js";
import { login } from "./login.js";
import { T3CodeAdapter } from "./t3code.js";

function signIn(config: T3CodeConfig, options: Options) {
  return login(config, {
    browser: !options["no-browser"],
    announce: (url) =>
      console.error(
        `Approve Agenvo in T3 Code (pairing code from Settings → Sharing & access or \`t3 auth pairing create\`), then choose its access:\n${url}\nOn another machine, paste the final address here after approving.`,
      ),
  });
}

export const backend: Backend<T3CodeConfig> = {
  name: "t3code",
  command: "agenvo-t3code",
  schema: instanceConfigSchema,
  executionPolicy,
  options: ["endpoint"],
  help: "--endpoint https://ENVIRONMENT/mcp [--no-browser] (sign in to a running T3 Code environment's MCP server)\nagenvo-t3code instance login --id ID [--no-browser] (sign in again after expiry or revocation)",
  revision: () => "t3code-mcp-orchestration-v1",
  async configure(options, dir) {
    if (options.binary || options.cwd)
      throw new Fault(
        "invalid_arguments",
        "T3 Code attachment uses the environment MCP URL; projects belong to the native server",
      );
    const id = identifier.parse(options.id);
    const config = instanceConfigSchema.parse({
      id,
      label: options.label ?? id,
      kind: "t3code",
      endpoint: options.endpoint,
      tokenFile: tokenPath(dir, id),
    });
    await signIn(config, options);
    const adapter = new T3CodeAdapter(config);
    try {
      await adapter.init();
      return config;
    } finally {
      await adapter.close();
    }
  },
  instanceCommands: {
    async login(config, options) {
      const result = await signIn(config, options);
      return {
        instanceId: config.id,
        signedIn: true,
        ...result,
        next: "Restart the connector to use the new sign-in.",
      };
    },
  },
  async create(config) {
    const adapter = new T3CodeAdapter(config);
    try {
      await adapter.init();
    } catch {
      /* Availability recovers when the environment answers again. */
      adapter.schedule();
    }
    return adapter;
  },
  async doctor(config) {
    const adapter = new T3CodeAdapter(config);
    try {
      await adapter.init();
      return [
        {
          check: config.id + ":server",
          ok: true,
          detail: `T3 Code ${adapter.version}: MCP connected, ${adapter.methods().length} orchestration tools`,
        },
      ];
    } catch (error) {
      return [
        {
          check: config.id + ":server",
          ok: false,
          detail:
            error instanceof Fault
              ? error.message
              : "Check the environment MCP URL and sign-in",
        },
      ];
    } finally {
      await adapter.close();
    }
  },
};
