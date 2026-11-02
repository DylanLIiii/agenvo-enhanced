import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  selectResourceURL,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Fault } from "@agenvo/protocol";
import { writeToken, type T3CodeConfig } from "./config.js";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

function openBrowser(url: string) {
  const child = spawn(
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open",
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url],
    { stdio: "ignore", detached: true },
  );
  child.on("error", () => {});
  child.unref();
}

/**
 * Sign this Connector in to the environment's MCP server with the native
 * outside-agent OAuth flow: dynamic public-client registration, PKCE and a
 * loopback redirect. The owner approves on T3 Code's own page with a pairing
 * code or a signed-in browser and chooses the access ceiling there.
 */
export async function login(
  config: T3CodeConfig,
  options: { browser: boolean; announce: (url: string) => void },
) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const state = randomBytes(16).toString("base64url");
  const abort = new AbortController();
  try {
    const info = await discoverOAuthServerInfo(config.endpoint);
    if (!info.authorizationServerMetadata)
      throw new Fault(
        "native_error",
        "The endpoint does not publish T3 Code MCP OAuth metadata; use the environment URL ending in /mcp",
      );
    const metadata = info.authorizationServerMetadata;
    const resource = await selectResourceURL(
      config.endpoint,
      {} as never,
      info.resourceMetadata,
    );
    const client = await registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata: {
        client_name: `Agenvo (${config.label})`,
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
    const { authorizationUrl, codeVerifier } = await startAuthorization(
      info.authorizationServerUrl,
      {
        metadata,
        clientInformation: client,
        redirectUrl,
        state,
        resource,
      },
    );
    const callback = (url: URL) => {
      if (url.searchParams.get("state") !== state)
        throw new Fault("invalid_state", "OAuth state does not match");
      const error = url.searchParams.get("error");
      if (error)
        throw new Fault(
          "native_rejected",
          `T3 Code sign-in was not approved: ${error}`,
          "rejected",
        );
      const code = url.searchParams.get("code");
      if (!code) throw new Fault("native_error", "No authorization code");
      return code;
    };
    const fromLoopback = new Promise<string>((resolve, reject) => {
      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUrl);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        try {
          const code = callback(url);
          res
            .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
            .end("Agenvo is signed in to T3 Code. You can close this page.");
          resolve(code);
        } catch (error) {
          res
            .writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
            .end("T3 Code sign-in failed. Return to the terminal.");
          reject(error);
        }
      });
    });
    // A browser on another machine cannot reach the loopback redirect; the
    // owner can paste the final address instead.
    const fromPaste = new Promise<string>((resolve, reject) => {
      if (!process.stdin.isTTY) return;
      const lines = createInterface({ input: process.stdin });
      abort.signal.addEventListener("abort", () => lines.close());
      lines.on("line", (line) => {
        if (!line.trim()) return;
        try {
          resolve(callback(new URL(line.trim())));
        } catch (error) {
          reject(error);
        }
        lines.close();
      });
    });
    options.announce(authorizationUrl.href);
    if (options.browser) openBrowser(authorizationUrl.href);
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      fromLoopback,
      fromPaste,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Fault("login_timeout", "T3 Code sign-in timed out")),
          LOGIN_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
      metadata,
      clientInformation: client,
      authorizationCode: code,
      codeVerifier,
      redirectUri: redirectUrl,
      resource,
    });
    await writeToken(config, {
      accessToken: tokens.access_token,
      clientId: client.client_id,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(tokens.expires_in
        ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
        : {}),
    });
    return { scope: tokens.scope, expiresIn: tokens.expires_in };
  } finally {
    abort.abort();
    server.close();
    server.closeAllConnections();
  }
}
