import { instanceConfigSchema as opencode } from "../../apps/opencode/src/config.js";
import {
  instanceConfigSchema as t3code,
  executionPolicy as t3codePolicy,
} from "../../apps/t3code/src/config.js";
import { z } from "zod";
import { instanceConfigSchema as herdr } from "../../apps/herdr/src/config.js";
import { instanceConfigSchema as codex } from "../../apps/codex-app-server/src/config.js";
import {
  instanceConfigSchema as amp,
  executionPolicy,
} from "../../apps/amp/src/config.js";
import { descriptor as describe } from "@agenvo/connector/config";
import { instanceConfigSchema as paseo } from "../../apps/paseo/src/config.js";
import { instanceConfigSchema as lody } from "../../apps/lody/src/config.js";
export { atomicJson, credentials } from "@agenvo/connector/config";
export { type HerdrConfig } from "../../apps/herdr/src/config.js";
export { type CodexConfig } from "../../apps/codex-app-server/src/config.js";
export const instanceConfigSchema = z.union([
  herdr,
  codex,
  paseo,
  amp,
  lody,
  opencode,
  t3code,
]);
export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
export const descriptor = (
  config: InstanceConfig,
  available: boolean,
  version: string,
) =>
  describe(
    config,
    available,
    version,
    config.kind === "t3code"
      ? "t3code-mcp-orchestration-v1"
      : config.kind === "opencode"
        ? "opencode-1.18.35-native-v1"
        : config.kind === "lody"
          ? "lody-cloud-3d478711-local-v7-native-v1"
          : config.kind === "paseo"
            ? "paseo-0.11.1-native-v1"
            : config.kind === "herdr"
              ? "herdr-core-0.1.15-native-v2"
              : config.kind === "amp"
                ? "amp-plugin-native-v1"
                : "codex-0.160.1-attach-native-v1",
    config.kind === "amp"
      ? executionPolicy.execution
      : config.kind === "opencode"
        ? "native-session-full-access"
        : config.kind === "t3code"
          ? t3codePolicy.execution
          : undefined,
  );
