import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Fault, VERSION, type Outcome } from "@agenvo/protocol";
import {
  bounded,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { readToken, type T3CodeConfig } from "./config.js";
import { exposed, methodsFrom, type NativeTool } from "./methods.js";

// Leave room inside the Relay's 10 second call budget for the reply.
const CALL_TIMEOUT_MS = 9000;
const RECONNECT_MS = 5000;
const HEARTBEAT_MS = 30000;
const ID_KEYS = ["threadId", "projectId", "runId", "requestId"] as const;

export class T3CodeAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private client?: Client;
  private catalog: Method[] = [];
  private stopped = false;
  private connecting?: Promise<void>;
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  lastError = "";

  constructor(readonly config: T3CodeConfig) {}

  methods() {
    return this.catalog;
  }

  init() {
    if (this.available && this.client) return Promise.resolve();
    if (this.reconnect) {
      clearTimeout(this.reconnect);
      this.reconnect = undefined;
    }
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect() {
    if (this.stopped) return;
    const token = await readToken(this.config);
    const client = new Client({ name: "agenvo-t3code", version: VERSION });
    const transport = new StreamableHTTPClientTransport(
      new URL(this.config.endpoint),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${token.accessToken}` },
        },
      },
    );
    try {
      await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
      const tools: NativeTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: CALL_TIMEOUT_MS,
        });
        tools.push(...(page.tools as NativeTool[]));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Fault(
            "native_error",
            "T3 Code repeated a tools/list cursor",
          );
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (this.stopped) {
        await client.close();
        return;
      }
      this.client = client;
      this.catalog = methodsFrom(tools);
      this.version = client.getServerVersion()?.version ?? "unknown";
      this.lastError = "";
      this.setAvailable(true);
      this.heartbeat = setInterval(() => {
        // A restarted environment forgets MCP sessions; probe so availability
        // reflects the native service rather than the last successful call.
        client.ping({ timeout: CALL_TIMEOUT_MS }).catch((error) => {
          this.lost(client, error);
        });
      }, HEARTBEAT_MS);
      this.heartbeat.unref();
    } catch (error) {
      await client.close().catch(() => {});
      throw this.describeConnectError(error);
    }
  }

  private describeConnectError(error: unknown) {
    if (error instanceof Fault) return error;
    if (unauthorized(error))
      return new Fault(
        "native_unauthorized",
        "T3 Code refused the sign-in (expired or revoked); run instance login",
      );
    return new Fault(
      "runtime_unavailable",
      "T3 Code MCP endpoint unavailable: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  private setAvailable(value: boolean) {
    if (this.available === value) return;
    this.available = value;
    this.onAvailabilityChange?.();
  }

  private lost(client: Client, error?: unknown) {
    if (this.client !== client) return;
    this.client = undefined;
    clearInterval(this.heartbeat);
    if (error) this.lastError = this.describeConnectError(error).message;
    this.setAvailable(false);
    void client.close().catch(() => {});
    this.schedule();
  }

  /** Reconnect observation only; business calls are never replayed. */
  schedule() {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.init().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.schedule();
      });
    }, RECONNECT_MS);
    this.reconnect.unref();
  }

  async call(name: string, params: Record<string, unknown>): Promise<Outcome> {
    if (!Object.hasOwn(exposed, name)) throw new Fault("unknown_method", name);
    const method = this.catalog.find((m) => m.name === name);
    const client = this.client;
    if (!client || !this.available) throw new Fault("runtime_unavailable");
    if (!method)
      throw new Fault(
        "unknown_method",
        `${name} is not offered by this T3 Code environment`,
      );
    const ids = nativeIds(params);
    try {
      const result = await client.request(
        { method: "tools/call", params: { name, arguments: params } },
        CallToolResultSchema,
        { timeout: CALL_TIMEOUT_MS },
      );
      const value = result.structuredContent ?? result.content;
      const allIds = { ...ids, ...nativeIds(result.structuredContent) };
      const nativeIdField = Object.keys(allIds).length
        ? { nativeIds: allIds }
        : {};
      if (result.isError)
        return bounded({
          execution: "rejected",
          ...nativeIdField,
          error: {
            code: "native_error",
            message: nativeMessage(result.content) ?? `${name} failed`,
            native: value,
          },
        });
      return bounded({
        execution: "accepted",
        result: value,
        ...nativeIdField,
      });
    } catch (error) {
      const fault = this.callFault(client, error, method.readOnly);
      return bounded({
        ...fault.outcome(),
        ...(ids ? { nativeIds: ids } : {}),
      });
    }
  }

  private callFault(client: Client, error: unknown, readOnly: boolean) {
    if (error instanceof McpError) {
      if (
        error.code === ErrorCode.InvalidParams ||
        error.code === ErrorCode.MethodNotFound ||
        error.code === ErrorCode.InvalidRequest
      )
        return new Fault("native_error", error.message, "rejected", {
          code: error.code,
          data: error.data,
        });
      if (error.code === ErrorCode.RequestTimeout)
        return new Fault(
          "native_timeout",
          "T3 Code did not answer in time; inspect native state before retrying",
          readOnly ? "not_started" : "unknown",
        );
    }
    if (unauthorized(error)) {
      this.lost(client, error);
      // T3 Code checks the credential before it runs a tool.
      return new Fault(
        "native_unauthorized",
        "T3 Code refused the sign-in; run instance login",
        "rejected",
      );
    }
    this.lost(client, error);
    // A lost response cannot prove that a dispatched write did not execute.
    return new Fault(
      "native_transport_error",
      "T3 Code response unavailable; inspect native state before retrying",
      readOnly ? "not_started" : "unknown",
    );
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    const client = this.client;
    this.client = undefined;
    this.available = false;
    // Closing the MCP session does not stop the environment or its runs.
    await client?.close().catch(() => {});
  }
}

function unauthorized(error: unknown) {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof StreamableHTTPError &&
      (error.code === 401 || error.code === 403))
  );
}

function nativeIds(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return;
  const ids: Record<string, string> = {};
  for (const key of ID_KEYS) {
    const id = (value as Record<string, unknown>)[key];
    if (typeof id === "string" && id.length <= 256) ids[key] = id;
  }
  return Object.keys(ids).length ? ids : undefined;
}

function nativeMessage(content: unknown) {
  if (!Array.isArray(content)) return;
  const text = content.find((c) => c?.type === "text")?.text;
  if (typeof text !== "string") return;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.message === "string") return parsed.message as string;
  } catch {
    /* Plain native text is the message. */
  }
  return text.slice(0, 1024);
}
