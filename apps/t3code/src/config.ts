import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import {
  absolutePath,
  atomicJson,
  commonInstanceFields,
} from "@agenvo/connector/config";

// T3 Code enforces the runtime-mode ceiling the owner chose when approving
// this client; the Connector neither raises nor narrows it.
export const executionPolicy = {
  execution: "native-mcp-grant-ceiling",
  approvalPolicy: "native-runtime-mode",
};
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("t3code"),
  endpoint: z.url().refine((value) => {
    const u = new URL(value);
    return (
      ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, "Use the environment MCP URL (for example https://host/mcp) without credentials, query parameters or fragment"),
  tokenFile: absolutePath,
});
export type T3CodeConfig = z.infer<typeof instanceConfigSchema>;

export const tokenSchema = z.object({
  accessToken: z.string().min(1),
  clientId: z.string().min(1),
  scope: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type StoredToken = z.infer<typeof tokenSchema>;

// Instance IDs may contain ':' or Windows device names. Encode them into
// portable, non-colliding filenames without restricting the shared ID syntax.
export const tokenPath = (dir: string, id: string) =>
  join(dir, "tokens", `instance-${Buffer.from(id).toString("base64url")}.json`);

export async function readToken(config: T3CodeConfig): Promise<StoredToken> {
  let info;
  try {
    info = await stat(config.tokenFile);
  } catch {
    throw new Fault(
      "native_unauthorized",
      "No T3 Code sign-in; run instance login for this instance",
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Fault(
      "insecure_credentials",
      "T3 Code token file must have mode 0600",
    );
  const token = tokenSchema.parse(
    JSON.parse(await readFile(config.tokenFile, "utf8")),
  );
  if (token.expiresAt !== undefined && token.expiresAt <= Date.now())
    throw new Fault(
      "native_unauthorized",
      "T3 Code sign-in expired; run instance login for this instance",
    );
  return token;
}
export const writeToken = (config: T3CodeConfig, token: StoredToken) =>
  atomicJson(config.tokenFile, token);
