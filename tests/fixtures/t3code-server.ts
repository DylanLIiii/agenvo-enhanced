import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";

// A protocol fixture for the T3 Code outside-agent MCP surface: OAuth
// authorization-code with PKCE, a stateful Streamable HTTP session and tools
// shaped like T3 Code 0.1.6's tools/list. Approval is automatic here; the
// system test exercises the real approval page contract.
const annotations = (readOnlyHint: boolean) => ({
  readOnlyHint,
  destructiveHint: !readOnlyHint,
  idempotentHint: readOnlyHint,
  openWorldHint: true,
});
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
});
const tools = [
  ["orchestrator_capabilities", true, object({})],
  ["t3_project_list", true, object({ cursor: { type: "integer" } })],
  ["t3_thread_list", true, object({ projectId: { type: "string" } })],
  [
    "t3_thread_read",
    false,
    object({ threadId: { type: "string" }, limit: { type: "integer" } }, [
      "threadId",
    ]),
  ],
  [
    "t3_thread_launch",
    false,
    object(
      {
        title: { type: "string" },
        projectId: { type: "string" },
        message: { type: "string" },
      },
      ["title"],
    ),
  ],
  [
    "t3_thread_send",
    false,
    object({ threadId: { type: "string" }, message: { type: "string" } }, [
      "threadId",
      "message",
    ]),
  ],
  [
    "t3_thread_wait",
    true,
    object({ threadId: { type: "string" }, timeoutMs: { type: "number" } }, [
      "threadId",
    ]),
  ],
  ["t3_thread_interrupt", false, object({ threadId: { type: "string" } })],
  [
    "t3_pending_request",
    false,
    object(
      {
        action: { type: "string" },
        threadId: { type: "string" },
        requestId: { type: "string" },
        answers: { type: "object" },
      },
      ["action"],
    ),
  ],
  // Thread-bound or surface tools that the Connector must not expose.
  ["preview_open", false, object({ url: { type: "string" } })],
  ["delegate_task", false, object({ task: { type: "string" } }, ["task"])],
  ["html_render", true, object({ html: { type: "string" } })],
].map(([name, readOnly, inputSchema]) => ({
  name,
  description: `Fixture ${name}.`,
  inputSchema,
  annotations: annotations(readOnly as boolean),
}));

async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

export async function t3codeFixture(
  options: { pageSize?: number; repeatCursor?: boolean } = {},
) {
  const calls: { name: string; arguments: any; session: string }[] = [];
  const listCursors: (string | undefined)[] = [];
  const sessions = new Set<string>();
  const tokens = new Set<string>();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const threads = new Map<string, any>([
    [
      "thread-external",
      {
        threadId: "thread-external",
        projectId: "project-1",
        title: "Started in the T3 Code app",
        status: "idle",
        messages: [{ role: "user", text: "Existing work" }],
      },
    ],
  ]);
  const pending = new Map<string, any>([
    [
      "request-1",
      {
        requestId: "request-1",
        threadId: "thread-external",
        question: "Proceed?",
      },
    ],
  ]);
  let initializations = 0;
  let dropNext = false;
  let toolErrorNext = false;
  let nextToolResult: unknown;
  let origin = "";
  const reply = (res: any, status: number, value: unknown, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(value));
  };
  const result = (value: Record<string, unknown>) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  });
  const run = (name: string, args: any) => {
    switch (name) {
      case "orchestrator_capabilities":
        return result({
          providers: [
            {
              providerInstanceId: "fixture",
              models: [{ id: "fixture-model" }],
            },
          ],
        });
      case "t3_project_list":
        return result({
          projects: [{ id: "project-1", title: "Fixture" }],
          nextCursor: null,
        });
      case "t3_thread_list":
        return result({
          projectId: args.projectId ?? "project-1",
          threads: [...threads.values()].map(({ messages, ...t }) => t),
          nextCursor: null,
        });
      case "t3_thread_read": {
        const thread = threads.get(args.threadId);
        if (!thread) break;
        return result({
          threadId: thread.threadId,
          status: thread.status,
          items: thread.messages,
        });
      }
      case "t3_thread_launch": {
        const threadId = "thread-" + randomUUID().slice(0, 8);
        threads.set(threadId, {
          threadId,
          projectId: args.projectId ?? "project-1",
          title: args.title,
          status: args.message ? "completed" : "idle",
          messages: args.message
            ? [
                { role: "user", text: args.message },
                { role: "assistant", text: "FIXTURE_OUTPUT" },
              ]
            : [],
        });
        return result({ threadId, link: `t3://thread/${threadId}` });
      }
      case "t3_thread_send": {
        const thread = threads.get(args.threadId);
        if (!thread) break;
        thread.messages.push(
          { role: "user", text: args.message },
          { role: "assistant", text: "FIXTURE_OUTPUT" },
        );
        thread.status = "completed";
        return result({
          threadId: thread.threadId,
          messageId: randomUUID(),
          runId: "run-1",
        });
      }
      case "t3_thread_wait": {
        const thread = threads.get(args.threadId);
        if (!thread) break;
        return result({
          threadId: thread.threadId,
          runId: "run-1",
          status: thread.status,
        });
      }
      case "t3_thread_interrupt":
        return result({ threadId: args.threadId, interrupted: true });
      case "t3_pending_request": {
        if (args.action === "list")
          return result({
            requests: [...pending.values()].filter(
              (r) => r.threadId === args.threadId,
            ),
          });
        if (args.action === "respond" && pending.delete(args.requestId))
          return result({ requestId: args.requestId, answered: true });
        break;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            _tag: "OrchestratorMcpFailure",
            code: "not_found",
            message: "Fixture target not found",
          }),
        },
      ],
      isError: true,
    };
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    const text = await body(req);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return reply(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["orchestration:read", "orchestration:operate"],
        bearer_methods_supported: ["header"],
        resource_name: "T3 Code fixture",
      });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return reply(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/mcp/authorize`,
        token_endpoint: `${origin}/oauth/mcp/token`,
        registration_endpoint: `${origin}/oauth/mcp/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/oauth/mcp/register") {
      const metadata = JSON.parse(text);
      return reply(res, 201, {
        ...metadata,
        client_id: "client-" + randomUUID(),
      });
    }
    if (url.pathname === "/oauth/mcp/authorize") {
      // Stand-in for the owner approving on the environment's page.
      const code = randomUUID();
      const redirect = url.searchParams.get("redirect_uri")!;
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge")!,
        redirect,
      });
      const target = new URL(redirect);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: target.href }).end();
      return;
    }
    if (url.pathname === "/oauth/mcp/token") {
      const form = new URLSearchParams(text);
      const grant = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      if (
        !grant ||
        grant.challenge !== challenge ||
        grant.redirect !== form.get("redirect_uri")
      )
        return reply(res, 400, {
          error: "invalid_grant",
          error_description: "Bad code",
        });
      codes.delete(form.get("code")!);
      const token = "token-" + randomUUID();
      tokens.add(token);
      return reply(res, 200, {
        access_token: token,
        token_type: "Bearer",
        expires_in: 2592000,
        scope: "orchestration:read orchestration:operate",
      });
    }
    if (url.pathname !== "/mcp") return reply(res, 404, { error: "not_found" });
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(token))
      return reply(
        res,
        401,
        { error: "invalid_mcp_credential" },
        {
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        },
      );
    if (req.method === "DELETE") {
      sessions.delete(String(req.headers["mcp-session-id"]));
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") return reply(res, 405, {});
    const message = JSON.parse(text);
    if (message.method === "initialize") {
      initializations++;
      const session = randomUUID();
      sessions.add(session);
      return reply(
        res,
        200,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "T3 Code", version: "9.9.9-fixture" },
          },
        },
        { "mcp-session-id": session },
      );
    }
    const session = String(req.headers["mcp-session-id"]);
    if (!sessions.has(session))
      return reply(res, 404, { error: "unknown_session" });
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (message.method === "ping")
      return reply(res, 200, { jsonrpc: "2.0", id: message.id, result: {} });
    if (message.method === "tools/list") {
      const cursor = message.params?.cursor as string | undefined;
      listCursors.push(cursor);
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(
        start + (options.pageSize ?? tools.length),
        tools.length,
      );
      return reply(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: tools.slice(start, end),
          ...(end < tools.length
            ? {
                nextCursor: String(
                  options.repeatCursor ? options.pageSize : end,
                ),
              }
            : {}),
        },
      });
    }
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      calls.push({ name, arguments: args, session });
      if (dropNext) {
        dropNext = false;
        req.socket.destroy();
        return;
      }
      if (toolErrorNext) {
        toolErrorNext = false;
        return reply(res, 200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: "Invalid arguments for tool" },
        });
      }
      const result = nextToolResult ?? run(name, args ?? {});
      nextToolResult = undefined;
      return reply(res, 200, {
        jsonrpc: "2.0",
        id: message.id,
        result,
      });
    }
    return reply(res, 200, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    endpoint: `${origin}/mcp`,
    calls,
    listCursors,
    threads,
    get initializations() {
      return initializations;
    },
    /** Issue a token as if the owner had approved this client earlier. */
    issue() {
      const token = "token-" + randomUUID();
      tokens.add(token);
      return token;
    },
    revokeAll() {
      tokens.clear();
    },
    /** A restarted environment forgets MCP sessions. */
    forgetSessions() {
      sessions.clear();
    },
    dropNextCall() {
      dropNext = true;
    },
    rejectNextCall() {
      toolErrorNext = true;
    },
    resultForNextCall(result: unknown) {
      nextToolResult = result;
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close").catch(() => {});
    },
  };
}
