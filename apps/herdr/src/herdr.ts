import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { z } from "zod";
import { bytes, Fault, type Outcome } from "@agenvo/protocol";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { methods } from "./methods.js";
import { request, subscribe } from "./core-rpc.js";
import type { HerdrConfig } from "./config.js";

export class HerdrAdapter implements Adapter {
  available = false;
  version = "unknown";
  onAvailabilityChange?: () => void;
  private stopEvents?: () => void;
  constructor(public config: HerdrConfig) {}
  private async hello() {
    const hello = (await request(
      this.config.endpoint,
      "hello",
      {
        generation: 1,
      },
      true,
    )) as any;
    if (hello.generation !== 1 || typeof hello.version !== "string")
      throw new Fault(
        "runtime_unavailable",
        "Unsupported Herdr Core protocol generation.",
      );
    this.version = hello.version;
  }
  async init() {
    await this.hello();
    this.available = true;
  }
  methods(): Method[] {
    return Object.entries(methods).map(([name, method]) => ({
      name,
      description: method.description,
      readOnly: method.readOnly,
      inputSchema: z.toJSONSchema(method.schema, {
        io: "input",
        unrepresentable: "any",
      }),
    }));
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    const definition = Object.hasOwn(methods, method)
      ? methods[method as keyof typeof methods]
      : undefined;
    if (!definition) throw new Fault("unsupported_method");
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success)
      throw new Fault(
        "invalid_params",
        parsed.error.issues
          .map((issue) => `${JSON.stringify(issue.path)}: ${issue.message}`)
          .join("; "),
      );
    return accepted(
      await request(
        this.config.endpoint,
        method,
        parsed.data,
        definition.readOnly,
      ),
    );
  }
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.stopEvents?.();
    let stopped = false;
    let socket: Socket | undefined;
    let retry: NodeJS.Timeout | undefined;
    let retryDelay = 1000;
    let lost = false;
    const serviceId = "default";
    const publish = (
      nativeType: string,
      native: Record<string, unknown>,
      threadId?: string,
    ) =>
      emit({
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        serviceId,
        ...(threadId && threadId.length <= 256 ? { threadId } : {}),
        nativeType,
        native:
          bytes(native) < 24000 ? native : { omittedBytes: bytes(native) },
      });
    const retryLater = () => {
      if (!lost) {
        lost = true;
        publish("agenvo.resync_required", {
          reason: "native_subscription_lost",
        });
      }
      retry = setTimeout(() => void start(), retryDelay);
      retryDelay = Math.min(30000, retryDelay * 2);
      retry.unref();
    };
    const start = async () => {
      if (stopped) return;
      const version = this.version;
      try {
        await this.hello();
      } catch {
        if (stopped) return;
        if (this.available) {
          this.available = false;
          this.onAvailabilityChange?.();
        }
        retryLater();
        return;
      }
      if (stopped) return;
      if (!this.available || version !== this.version) {
        this.available = true;
        this.onAvailabilityChange?.();
      }
      socket = subscribe(
        this.config.endpoint,
        (packet) => {
          if (packet.id === 1 && packet.result) {
            lost = false;
            retryDelay = 1000;
            publish("agenvo.resync_required", {
              reason: "native_subscription_ready",
            });
          } else if (packet.method === "missed") {
            publish("agenvo.resync_required", {
              reason: "native_events_missed",
              seq: packet.params?.seq,
            });
          } else if (
            packet.method === "event" &&
            typeof packet.params?.type === "string"
          ) {
            publish(packet.params.type, packet.params, packet.params.terminal);
          }
        },
        () => {
          if (stopped) return;
          retryLater();
        },
      );
    };
    start();
    return (this.stopEvents = () => {
      stopped = true;
      clearTimeout(retry);
      socket?.destroy();
    });
  }
  async close() {
    this.stopEvents?.();
  }
}
