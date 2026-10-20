import { bytes } from "@agenvo/protocol";
import type { Turn } from "./protocol.js";

/** Native data above this size is reduced to identity plus a read target. */
export const EVENT_LIMIT = 24 * 1024;

/** How this Connector process treats permission requests of a Session. */
export type PermissionHandling = "auto_approve_plain" | "explicit" | "unknown";

/** Turn form shared by history reads and oversized events. */
export function truncatedTurn(turn: Turn, omittedBytes: number) {
  return {
    id: turn.id,
    role: turn.role,
    status: turn.status,
    finished: turn.finished,
    endedAt: turn.endedAt,
    truncated: true,
    omittedBytes,
  };
}

// Small metadata fields that decide what a consumer reads next.
const keptPatchKeys = [
  "status",
  "awaitingUserSince",
  "processingUserMsgId",
  "lastHandledUserMsgId",
  "isArchived",
];

/**
 * Add Agenvo identity to native event data without touching native fields, then
 * bound the result. Identity and a deterministic read target always survive.
 */
export function sessionEventData(
  type: string,
  sessionId: string,
  native: Record<string, any>,
  options: {
    meta?: Record<string, any>;
    turnId?: string;
    permissionHandling: PermissionHandling;
  },
): Record<string, unknown> {
  const meta = options.meta ?? {};
  const patch = native.patch;
  const turnId =
    options.turnId ??
    [patch?.processingUserMsgId, patch?.lastHandledUserMsgId].find(
      (id) => typeof id === "string",
    );
  const agenvo: Record<string, unknown> = {
    sessionId,
    ...(typeof meta.agentConfigId === "string"
      ? { agentConfigId: meta.agentConfigId }
      : {}),
    ...(typeof meta.agentType === "string"
      ? { agentType: meta.agentType }
      : {}),
    ...(typeof meta.cliType === "string" ? { cliType: meta.cliType } : {}),
    ...(typeof meta.machineId === "string"
      ? { machineId: meta.machineId }
      : {}),
    ...(turnId ? { turnId } : {}),
    permissionHandling: options.permissionHandling,
  };
  const full = { ...native, agenvo };
  const size = bytes(full);
  if (size <= EVENT_LIMIT) return full;
  const base = { truncated: true, omittedBytes: size };
  if (native.turn && typeof native.turn.id === "string")
    return {
      ...base,
      turn: truncatedTurn(native.turn, bytes(native.turn)),
      agenvo: {
        ...agenvo,
        turnId: native.turn.id,
        read: {
          method: "lody.sessions.turn",
          sessionId,
          turnId: native.turn.id,
        },
      },
    };
  if (typeof native.requestId === "string" && native.permissionRequest)
    return {
      sessionId,
      turnId: native.turnId,
      requestId: native.requestId,
      toolCallId: native.toolCallId,
      title: native.title,
      permissionRequest: {
        options: (native.permissionRequest.options ?? []).map((o: any) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
        hasMeta: native.permissionRequest._meta != null,
      },
      ...base,
      agenvo: {
        ...agenvo,
        read: { method: "lody.interactions.list", sessionId },
      },
    };
  if (patch && typeof patch === "object")
    return {
      kind: native.kind,
      docId: native.docId,
      by: native.by,
      ...base,
      patch: Object.fromEntries(
        keptPatchKeys.filter((k) => k in patch).map((k) => [k, patch[k]]),
      ),
      omittedKeys: Object.keys(patch).filter((k) => !keptPatchKeys.includes(k)),
      agenvo: { ...agenvo, read: { method: "lody.sessions.get", sessionId } },
    };
  return {
    ...base,
    agenvo: { ...agenvo, read: { method: "lody.sessions.get", sessionId } },
  };
}

/**
 * Native Lody treats running, requestPermission and initializing as active
 * Session statuses; a pending user question or a processing user turn also
 * means something is happening that a consumer may need to react to.
 */
export function isActive(meta: Record<string, any>) {
  return (
    ["running", "requestPermission", "initializing"].includes(
      meta.status?.type,
    ) ||
    (meta.awaitingUserSince ?? null) !== null ||
    typeof meta.processingUserMsgId === "string"
  );
}

/**
 * A published ACP capability row, as the daemon wrote it. It describes an
 * agent configuration, not a Session, so there is no thread. An oversized row
 * is reduced to the identifiers a selection is validated against.
 */
export function capabilityEventData(
  agentConfigId: string,
  machineId: string,
  capability: any,
  config?: Record<string, any>,
): Record<string, unknown> {
  const agenvo = {
    agentConfigId,
    machineId,
    ...(typeof config?.agentType === "string"
      ? { agentType: config.agentType }
      : {}),
    ...(typeof config?.cliType === "string" ? { cliType: config.cliType } : {}),
    read: { method: "lody.catalog", machineId },
  };
  const full = { capability, agenvo };
  const size = bytes(full);
  if (size <= EVENT_LIMIT) return full;
  const ids = (rows: any, key: string) =>
    Array.isArray(rows)
      ? rows.map((r: any) => r?.[key]).filter((v) => typeof v === "string")
      : [];
  return {
    truncated: true,
    omittedBytes: size,
    capability: {
      modes: ids(capability?.modes, "id"),
      models: ids(capability?.models, "modelId"),
      configOptions: ids(capability?.configOptions, "id"),
    },
    agenvo,
  };
}
