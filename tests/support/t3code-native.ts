import { execa } from "execa";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { binary } from "@agenvo/connector/cli/binary";
import { isolatedEnvironment, until } from "./environment.js";
import { stopProcess } from "./process.js";

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

/**
 * Start an isolated T3 Code environment with its Codex provider pointed at a
 * local model fixture. `T3CODE_HOME` keeps the downloaded runtime outside the
 * personal data directory; `--base-dir` holds this environment's state.
 */
export async function nativeT3Code(root: string, modelBaseUrl: string) {
  const home = join(root, "t3-home");
  const baseDir = join(root, "t3-state");
  const codexHome = join(home, "codex");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(baseDir, "userdata"), { recursive: true });
  await writeFile(
    join(codexHome, "config.toml"),
    `model = "fixture"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated model"\nbase_url = ${JSON.stringify(modelBaseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,
  );
  const t3 = await binary("t3", {});
  const env = {
    ...isolatedEnvironment(home),
    CODEX_HOME: codexHome,
    T3CODE_HOME: process.env.AGENVO_T3CODE_HOME ?? join(home, ".t3"),
  };
  const port = await freePort();
  const child = execa(
    t3,
    [
      "serve",
      "--base-dir",
      baseDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
      root,
    ],
    {
      cwd: root,
      reject: false,
      extendEnv: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  let logs = "";
  child.stdout.on("data", (c) => {
    logs += c;
  });
  child.stderr.on("data", (c) => {
    logs += c;
  });
  child.on("error", (e) => {
    logs += String(e);
  });
  const close = () => stopProcess(child);
  const origin = `http://127.0.0.1:${port}`;
  try {
    // The first start may download the pinned runtime into T3CODE_HOME.
    await until(
      async () => {
        if (child.exitCode !== null) throw new Error(logs);
        return fetch(origin + "/.well-known/oauth-authorization-server")
          .then((r) => r.ok)
          .catch(() => false);
      },
      Boolean,
      180000,
    );
    const cli = (args: string[]) =>
      execa(t3, [...args, "--base-dir", baseDir], { env, extendEnv: false });
    return {
      origin,
      endpoint: `${origin}/mcp`,
      baseDir,
      /** One-time code the owner enters on the approval page. */
      async pairingCode() {
        const { stdout } = await cli([
          "auth",
          "pairing",
          "create",
          "--ttl",
          "5m",
          "--json",
        ]);
        return JSON.parse(stdout).credential as string;
      },
      cli,
      close,
      logs: () => logs,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Approve an outside-agent sign-in the way T3 Code's approval page does:
 * the owner enters a pairing code and chooses the access ceiling.
 */
export async function approveSignIn(
  origin: string,
  authorizationUrl: string,
  code: string,
  access = "full-access",
) {
  const page = new URL(authorizationUrl);
  const authorization = Object.fromEntries(
    [
      "response_type",
      "client_id",
      "redirect_uri",
      "code_challenge",
      "code_challenge_method",
      "state",
      "resource",
    ]
      .filter((key) => page.searchParams.has(key))
      .map((key) => [key, page.searchParams.get(key)]),
  );
  const response = await fetch(origin + "/oauth/mcp/decision", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      authorization,
      decision: { _tag: "pairing-code", access, code },
    }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`Approval failed ${response.status}: ${text}`);
  return (JSON.parse(text) as { redirectTo: string }).redirectTo;
}
