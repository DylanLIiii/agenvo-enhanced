import { randomUUID } from "node:crypto";
import { LoroRepo, type RepoRoomSubscription } from "loro-repo";
import { isContainer, type LoroDoc, type LoroMap } from "loro-crdt";
import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import type { LodyConfig } from "./config.js";
import { CloudConnection } from "./cloud.js";
import { LocalConnection } from "./local.js";
import {
  isActive,
  sessionEventData,
  type PermissionHandling,
} from "./events.js";
import type { LodyConnection } from "./connection.js";
import {
  appendUserTurn,
  createInput,
  pendingInteractions,
  permissionOutcomeOf,
  readTurn,
  sessionSchema,
  writePermission,
  type Session,
  type permissionInput,
  type sendInput,
} from "./protocol.js";

type Selection =
  { modeId: string } | { configOptionValues: Record<string, string> };

function modeIds(capability: any) {
  const ids = new Set<string>(
    (capability?.modes ?? []).map((mode: any) => mode.id),
  );
  for (const option of capability?.configOptions ?? [])
    if (option.category === "mode" && option.type === "select")
      for (const value of option.options ?? [])
        if (typeof value.value === "string") ids.add(value.value);
  return ids;
}

function fullAccessSelection(
  config: any,
  capability: any,
): Selection | undefined {
  if (config.cliType !== "builtin" || !capability) return;
  const modes = modeIds(capability);
  const mode = (ids: string[]) => {
    const modeId = ids.find((id) => modes.has(id));
    return modeId ? { modeId } : undefined;
  };
  // Identifiers follow the native client's own full-access classification. They
  // are only meaningful for builtin providers; registry and custom agents stay
  // caller-explicit.
  switch (config.agentType) {
    case "codex":
      return mode(["agent-full-access", "danger-full-access"]);
    case "claude":
      return mode(["bypassPermissions"]);
    case "deepseek":
      return mode(["danger-full-access"]);
    case "kimi": {
      const option = (capability.configOptions ?? []).find(
        (o: any) => o.id === "permission_mode" && o.type === "select",
      );
      if (option?.options?.some((v: any) => v.value === "yolo"))
        return { configOptionValues: { permission_mode: "yolo" } };
      return mode(["yolo"]);
    }
  }
}

function validateSelection(
  capability: any,
  requested: Pick<
    z.infer<typeof sendInput>,
    "modeId" | "modelId" | "configOptionValues"
  >,
) {
  const reject = (message: string) => {
    throw new Fault("invalid_params", message);
  };
  const options: any[] = capability.configOptions ?? [];
  const selectValues = (category: string) =>
    options
      .filter((o) => o.category === category && o.type === "select")
      .flatMap((o) => (o.options ?? []).map((v: any) => v.value));
  if (requested.modeId && !modeIds(capability).has(requested.modeId))
    reject(
      `Unsupported ACP mode for this agent configuration: ${requested.modeId}`,
    );
  if (
    requested.modelId &&
    ![
      ...(capability.models ?? []).map((m: any) => m.modelId),
      ...selectValues("model"),
    ].includes(requested.modelId)
  )
    reject(
      `Unsupported ACP model for this agent configuration: ${requested.modelId}`,
    );
  for (const [id, value] of Object.entries(
    requested.configOptionValues ?? {},
  )) {
    const option = options.find((o) => o.id === id);
    if (!option) reject(`Unknown ACP config option: ${id}`);
    else if (option.type === "boolean") {
      if (typeof value !== "boolean")
        reject(`Config option ${id} expects a boolean value`);
    } else if (
      typeof value !== "string" ||
      !(option.options ?? []).some((v: any) => v.value === value)
    )
      reject(`Unsupported value for ACP config option ${id}`);
  }
}

export async function bounded<T>(
  promise: Promise<T>,
  milliseconds = 7000,
): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Fault(
                "native_timeout",
                "Lody confirmation timed out",
                "unknown",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
/** Observation outlives the last activity by this long (tests shorten it). */
export const observation = { graceMs: 30000 };
type DocEntry = {
  opened: Promise<OpenSession>;
  leases: number;
  observed: boolean;
  used: number;
};
type OpenSession = {
  doc: LoroDoc;
  room: RepoRoomSubscription;
  off: () => void;
};
export class LodyWorkspace {
  readonly connection: LodyConnection;
  get repo() {
    return this.connection.repo;
  }
  get mode() {
    return this.connection.name;
  }
  private confirmation(kind: string) {
    return `${this.mode}_${kind}_${this.mode === "cloud" ? "synced" : "received"}`;
  }
  meta!: RepoRoomSubscription;
  private docs = new Map<string, DocEntry>();
  private graces = new Map<string, NodeJS.Timeout>();
  // Requests already announced as pending, per Session (JSON [turnId, requestId]).
  private announced = new Map<string, Set<string>>();
  private sweeper?: NodeJS.Timeout;
  private machines = new Map<
    string,
    Promise<{
      flock: Awaited<ReturnType<LoroRepo["openFlockDoc"]>>["flock"];
      room: RepoRoomSubscription;
    }>
  >();
  private policies = new Map<string, PermissionHandling>();
  private publishing: Promise<void> = Promise.resolve();
  private responding = new Set<string>();
  private closed = false;
  private off?: () => void;
  onEvent?: (
    type: string,
    sessionId: string | undefined,
    native: Record<string, unknown>,
  ) => void;
  onGap?: (sessionId?: string, reason?: string) => void;
  onAvailability?: (available: boolean) => void;
  onDisconnect?: () => void;
  constructor(readonly config: LodyConfig) {
    this.connection =
      config.mode === "local"
        ? new LocalConnection(config)
        : new CloudConnection(config);
    this.connection.onDisconnect = () => this.onDisconnect?.();
  }
  async start() {
    await this.connection.start();
    this.meta = await this.repo.joinMetaRoom();
    await this.caughtUp(this.meta);
    this.meta.subscription(this.mode).onStatusChange((status) => {
      if (this.closed) return;
      if (status !== "joined") {
        this.onGap?.();
        this.onAvailability?.(false);
      } else
        void this.caughtUp(this.meta).then(
          () => this.onAvailability?.(true),
          () => this.onAvailability?.(false),
        );
    });
    this.off = this.repo.watch((event) => {
      if (
        !("docId" in event) ||
        !event.docId.startsWith("session-") ||
        event.docId.startsWith("session-comment-")
      )
        return;
      this.publish(event.kind, event.docId.slice(8), { ...event }, true);
    }).unsubscribe;
    this.sweeper = setInterval(() => {
      for (const [id, found] of this.docs)
        if (
          !found.leases &&
          !found.observed &&
          Date.now() - found.used > observation.graceMs
        )
          this.drop(id);
    }, 5000);
    this.sweeper.unref();
    void this.observeActive();
  }
  /**
   * Publish one Session event in arrival order with the Session's current
   * identity. Local attachment only reports Sessions of its own machine.
   */
  private publish(
    type: string,
    id: string,
    native: Record<string, unknown>,
    watched = false,
    turnId?: string,
  ) {
    this.publishing = this.publishing.then(async () => {
      if (this.closed) return;
      let meta: Record<string, any> | undefined;
      try {
        meta = (await this.repo.getDocMeta(`session-${id}`))?.meta;
      } catch {
        this.onGap?.(id);
        return;
      }
      if (
        watched &&
        this.config.mode === "local" &&
        meta?.machineId !== this.config.machineId
      )
        return;
      if (this.closed) return;
      this.onEvent?.(
        type,
        id,
        sessionEventData(type, id, native, {
          meta,
          turnId,
          permissionHandling: this.permissionHandling(id),
        }),
      );
      if (watched && type === "doc-metadata" && meta)
        void this.observe(id, meta);
    });
  }
  private permissionHandling(id: string): PermissionHandling {
    return this.policies.get(id) ?? "unknown";
  }
  private async caughtUp(room: RepoRoomSubscription) {
    if (this.closed) throw new Fault("runtime_unavailable");
    const result = await room
      .subscription(this.mode)
      .waitFor({ phase: "caught-up", timeoutMs: 6000 });
    if (result.status !== "complete")
      throw new Fault(`${this.mode}_unsynced`, "Lody data is not synchronized");
  }
  private async uploaded(room: RepoRoomSubscription) {
    await bounded(this.connection.uploaded(room));
  }
  async list(includeArchived = false) {
    await this.caughtUp(this.meta);
    return (await this.repo.listDoc({ prefix: "session-" }))
      .filter(
        (row) =>
          !row.deleted &&
          !row.docId.startsWith("session-comment-") &&
          (includeArchived || !row.meta.isArchived) &&
          (this.config.mode !== "local" ||
            row.meta.machineId === this.config.machineId),
      )
      .map((row) => {
        const session = sessionSchema.parse(row.meta);
        if (`session-${session.id}` !== row.docId)
          throw new Fault("invalid_native_result");
        return session;
      });
  }
  async get(id: string): Promise<Session> {
    await this.caughtUp(this.meta);
    const row = await this.repo.getDocMeta(`session-${id}`);
    if (!row || row.deleted) throw new Fault("not_found");
    const parsed = sessionSchema.safeParse(row.meta);
    if (!parsed.success || parsed.data.id !== id)
      throw new Fault("invalid_native_result");
    if (
      this.config.mode === "local" &&
      parsed.data.machineId !== this.config.machineId
    )
      throw new Fault("unauthorized", "Session belongs to another machine");
    return parsed.data;
  }
  async catalog(machineId?: string) {
    await this.caughtUp(this.meta);
    const machines = (await this.repo.listDoc({ prefix: "machine-" }))
      .filter(
        (row) =>
          !row.deleted &&
          (this.config.mode !== "local" ||
            row.meta.id === this.config.machineId),
      )
      .map((row) => row.meta);
    if (!machineId) return { machines };
    if (!machines.some((m) => m.id === machineId)) throw new Fault("not_found");
    await this.connection.machineAccess(machineId);
    const { flock, room } = await this.machine(machineId);
    await this.caughtUp(room);
    return {
      machine: machines.find((m) => m.id === machineId),
      agentConfigs: flock.scan({ prefix: ["agentConfig"] }).map((row) => {
        const c = row.value as any;
        // Agent configuration env and auth profiles can contain secrets.
        return {
          id: c.id,
          machineId: c.machineId,
          name: c.name,
          cliType: c.cliType,
          agentType: c.agentType,
        };
      }),
      capabilities: flock
        .scan({ prefix: ["acpCapability"] })
        .map((row) => ({ agentConfigId: row.key[1], value: row.value })),
      projects: flock.scan({ prefix: ["localProject"] }).map((row) => {
        const p = row.value as any;
        return {
          id: p.id,
          name: p.name,
          rootPath: p.rootPath,
          githubRepoFullName: p.githubRepoFullName,
        };
      }),
    };
  }
  private async machine(id: string) {
    let found = this.machines.get(id);
    if (!found) {
      if (this.machines.size >= 128) throw new Fault("resource_exhausted");
      found = (async () => {
        const name = `${this.config.workspaceId}:mf:${id}`;
        const { flock } = await this.repo.openFlockDoc(name);
        const room = await this.repo.joinFlockDocRoom(name);
        return { flock, room };
      })();
      this.machines.set(id, found);
      found.catch(() => this.machines.delete(id));
    }
    return found;
  }
  private async executionConfig(
    machineId: string,
    configId: string | undefined,
    project?: z.infer<typeof createInput>["project"],
    requested: Pick<
      z.infer<typeof sendInput>,
      "modeId" | "modelId" | "configOptionValues"
    > = {},
  ) {
    if (!configId)
      throw new Fault(
        "unsupported_capability",
        "Session has no agent configuration identity",
      );
    await this.connection.machineAccess(
      machineId,
      project?.kind === "local" ? project.localProjectId : undefined,
    );
    const { flock, room } = await this.machine(machineId);
    await this.caughtUp(room);
    const config = flock.get(["agentConfig", configId]) as any;
    const capability = flock.get(["acpCapability", configId]) as any;
    if (!config || config.id !== configId || config.machineId !== machineId)
      throw new Fault("not_found", "Lody agent configuration is unavailable");
    const execution = {
      cliType: String(config.cliType),
      agentType: String(config.agentType),
    };
    const explicit = requested.modeId || requested.configOptionValues;
    if (requested.modeId || requested.modelId || requested.configOptionValues) {
      // The native daemon forwards user-turn selections to the ACP agent without
      // validating them, so check them against the agent's own capability first.
      if (!capability)
        throw new Fault(
          "unsupported_capability",
          "The native runtime has not published this agent configuration's capabilities yet; retry after Lody probes it, or omit the selection",
        );
      validateSelection(capability, requested);
    }
    const base = {
      ...execution,
      ...(requested.modeId ? { modeId: requested.modeId } : {}),
      ...(requested.configOptionValues
        ? { configOptionValues: requested.configOptionValues }
        : {}),
    };
    // Without an explicit permission selection, builtin providers whose native
    // capability advertises a recognized full-access setting run in full access.
    // Everything else keeps the native default and explicit interactions.
    const fullAccess = explicit
      ? undefined
      : fullAccessSelection(config, capability);
    return {
      ...base,
      ...fullAccess,
      autoApprove: fullAccess !== undefined,
    };
  }
  private async quota(doc?: LoroDoc) {
    const entitlement = await this.connection.entitlement();
    if (!entitlement) return;
    if (entitlement.checkoutPending)
      throw new Fault(
        "workspace_payment_required",
        "Complete Lody checkout before creating Sessions or sending input",
      );
    if (entitlement.effectivePlanTier !== "free") return;
    // Native cooperative quotas from packages/shared/src/billing.ts at the
    // audited revision. Archived Sessions still count; deleted ones do not.
    let count = 0;
    if (doc) {
      const list = doc.getList("history");
      for (let i = 0; i < list.length; i++)
        if (readTurn(doc, i).role === "user") count++;
      count += doc.getList("mq").length;
    } else count = (await this.list(true)).length;
    if (count >= (doc ? 30 : 200))
      throw new Fault(
        "native_quota_reached",
        "The native Lody free workspace quota was reached",
      );
  }
  async create(input: z.infer<typeof createInput>) {
    const execution = await this.executionConfig(
      input.machineId,
      input.agentConfigId,
      input.project,
    );
    await this.quota();
    const id = randomUUID(),
      roomId = `session-${id}`;
    const session = {
      ...input,
      id,
      userId: this.config.userId,
      cliType: execution.cliType,
      agentType: execution.agentType,
      status: { type: "idle" },
      isArchived: false,
      createdAt: new Date().toISOString(),
      historyBackend: "loro",
      ...(input.title ? { titleSource: "user" } : {}),
      ...(input.project?.kind === "github"
        ? {
            repoFullName: input.project.repoFullName,
            baseBranch: input.project.branch,
            isWorktree: true,
          }
        : {}),
      ...(input.project?.kind === "local" && input.project.useWorktree
        ? { isWorktree: true }
        : {}),
    };
    try {
      await this.connection.ensureDoc(roomId);
      await this.repo.upsertDocMeta(roomId, session);
      await this.uploaded(this.meta);
      return { session, confirmation: this.confirmation("metadata") };
    } catch (error) {
      throw new Fault(
        `${this.mode}_create_uncertain`,
        "Lody creation was not confirmed",
        "unknown",
        { sessionId: id },
      );
    }
  }
  /**
   * Open a Session document for reading or observation. Each open document
   * holds one native room, so at most 128 are open at once. Documents that
   * nobody leases or observes are evicted, least recently used first.
   */
  private async entry(id: string): Promise<DocEntry> {
    const session = await this.get(id);
    if (session.historyBackend && session.historyBackend !== "loro")
      throw new Fault(
        "unsupported_capability",
        "Unsupported native history backend",
      );
    await this.connection.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    let found = this.docs.get(id);
    if (!found) {
      if (this.docs.size >= 128 && !this.evict())
        throw new Fault(
          "resource_exhausted",
          "At most 128 Session documents can be leased or observed at once per connector",
        );
      const created: DocEntry = {
        opened: this.openDocument(id),
        leases: 0,
        observed: false,
        used: Date.now(),
      };
      found = created;
      this.docs.set(id, created);
      created.opened.catch(() => {
        if (this.docs.get(id) === created) this.docs.delete(id);
      });
    }
    return found;
  }
  private evict() {
    let victim: [string, DocEntry] | undefined;
    for (const candidate of this.docs)
      if (
        !candidate[1].leases &&
        !candidate[1].observed &&
        (!victim || candidate[1].used < victim[1].used)
      )
        victim = candidate;
    if (!victim) return false;
    this.drop(victim[0]);
    return true;
  }
  private drop(id: string) {
    const found = this.docs.get(id);
    this.docs.delete(id);
    void found?.opened.then(
      (opened) => {
        opened.off();
        opened.room.unsubscribe();
      },
      () => {},
    );
  }
  /** Lease a document for one operation; it cannot be evicted until released. */
  async use<T>(
    id: string,
    run: (opened: {
      doc: LoroDoc;
      room: RepoRoomSubscription;
    }) => Promise<T> | T,
  ): Promise<T> {
    const found = await this.entry(id);
    found.leases++;
    try {
      const opened = await found.opened;
      await this.caughtUp(opened.room);
      return await run(opened);
    } finally {
      found.leases--;
      found.used = Date.now();
    }
  }
  /** Ensure the document is open without keeping it. */
  document(id: string) {
    return this.use(id, (opened) => opened);
  }
  private async openDocument(id: string): Promise<OpenSession> {
    const { doc } = await this.repo.openPersistedDoc(`session-${id}`);
    const room = await this.repo.joinDocRoom(`session-${id}`);
    try {
      await this.caughtUp(room);
    } catch (error) {
      room.unsubscribe();
      throw error;
    }
    const statusOff = room.subscription(this.mode).onStatusChange((status) => {
      if (status !== "joined") this.onGap?.(id);
    });
    const off = doc.subscribe((event) => {
      if (event.by === "local") return;
      const positions = new Set<number>();
      let structural = false;
      for (const change of event.events) {
        if (change.path[0] !== "history") continue;
        if (typeof change.path[1] === "number") positions.add(change.path[1]);
        else structural = true;
      }
      const count = doc.getList("history").length;
      if (structural) {
        if (count > 50) this.onGap?.(id);
        for (let i = Math.max(0, count - 50); i < count; i++) positions.add(i);
      }
      for (const index of positions) {
        if (index >= count) continue;
        try {
          const turn = readTurn(doc, index);
          this.publish("history.updated", id, { turn }, false, turn.id);
        } catch {
          this.onGap?.(id);
        }
      }
      this.scan(id, doc);
      if (this.policies.get(id) === "auto_approve_plain")
        void this.approvePermissions(id, doc);
    });
    // Requests that were already waiting when the document opened.
    this.scan(id, doc);
    return {
      doc,
      room,
      off: () => {
        off();
        statusOff();
      },
    };
  }
  /**
   * Keep the history of Sessions that are doing something open, so their turns
   * and permission requests produce events without any caller action. Quiet
   * Sessions are released after a grace period that lets the final turn arrive.
   */
  private async observe(id: string, meta: Record<string, any>) {
    const timer = this.graces.get(id);
    if (isActive(meta)) {
      clearTimeout(timer);
      this.graces.delete(id);
      const current = this.docs.get(id);
      if (current?.observed) return;
      try {
        const found = await this.entry(id);
        found.observed = true;
        await found.opened;
      } catch (error) {
        if (error instanceof Fault && error.code === "resource_exhausted")
          this.onGap?.(id, "observation_capacity");
      }
      return;
    }
    if (!this.docs.get(id)?.observed || timer) return;
    const release = () => {
      this.graces.delete(id);
      const found = this.docs.get(id);
      if (!found?.observed) return;
      void found.opened.then(
        (opened) => {
          if (this.closed) return;
          if (pendingInteractions(opened.doc).length) {
            this.graces.set(id, setTimeout(release, observation.graceMs));
            return;
          }
          found.observed = false;
          found.used = Date.now();
        },
        () => {},
      );
    };
    this.graces.set(id, setTimeout(release, observation.graceMs));
  }
  private async observeActive() {
    try {
      for (const session of await this.list()) {
        if (this.closed) return;
        if (isActive(session)) await this.observe(session.id, session);
      }
    } catch {
      /* Metadata events open the rest as Sessions change. */
    }
  }
  async send(input: z.infer<typeof sendInput>, expectedTurnId?: string) {
    const session = await this.get(input.sessionId);
    if (session.isArchived)
      throw new Fault(
        "invalid_state",
        "Restore the archived Session before sending",
      );
    const execution = await this.executionConfig(
      session.machineId,
      session.agentConfigId,
      session.project,
      input,
    );
    if (
      execution.cliType !== session.cliType ||
      execution.agentType !== session.agentType
    )
      throw new Fault(
        "invalid_state",
        "Native agent configuration changed provider",
      );
    return this.use(session.id, async ({ doc, room }) => {
      await this.quota(doc);
      const live = await this.live(session);
      if (live.state === "unknown")
        throw new Fault(
          "runtime_unavailable",
          "Target machine cannot confirm Session availability",
        );
      const userTurnId = randomUUID(),
        timestamp = new Date().toISOString();
      const { autoApprove, ...selection } = execution;
      const inputConfig = {
        ...selection,
        prompt: input.text,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(expectedTurnId ? { _lodyDeliveryKind: "steer" } : {}),
      };
      // Automatic approval of plain execution permissions follows this turn's
      // policy; a Session that moves to an explicit or native-default policy stops.
      this.policies.set(
        session.id,
        autoApprove ? "auto_approve_plain" : "explicit",
      );
      try {
        doc.getMap("session").set("id", session.id);
        appendUserTurn(doc, {
          id: userTurnId,
          userId: this.config.userId,
          text: input.text,
          timestamp,
          inputConfig,
          steer: !!expectedTurnId,
        });
        await this.uploaded(room);
        if (expectedTurnId) {
          const result = await this.connection.call(
            session.machineId,
            "session/steer",
            {
              sessionId: session.id,
              expectedTurnId,
              userTurnId,
              userId: this.config.userId,
              timestamp,
              inputConfig,
            },
          );
          if (!result?.applied && result?.recoveryOwned === true)
            // The daemon owns recovery: it requeues the input as a follow-up turn
            // (for example when the provider cannot steer). It is not lost or rejected.
            return {
              sessionId: session.id,
              userTurnId,
              confirmation: "native_steer_requeued",
              disposition: result.disposition,
              recoveryOwned: true,
              native: result,
            };
          if (!result?.applied)
            throw new Fault(
              "native_steer_not_applied",
              "Lody did not confirm steer application",
              "unknown",
              { sessionId: session.id, userTurnId, native: result },
            );
          const history = doc.getList("history");
          for (let i = history.length - 1; i >= 0; i--) {
            const row = history.get(i);
            if (
              isContainer(row) &&
              row.kind() === "Map" &&
              (row as LoroMap).get("id") === userTurnId &&
              (row as LoroMap).get("status") === "pending_apply"
            ) {
              (row as LoroMap).set("status", "processing");
              (row as LoroMap).set("read", true);
              doc.commit();
              break;
            }
          }
          await this.uploaded(room);
          return {
            sessionId: session.id,
            userTurnId,
            confirmation: "native_steer_applied",
            native: result,
          };
        }
        await this.repo.upsertDocMeta(`session-${session.id}`, {
          latestUserMsgId: userTurnId,
          lastMissingHistoryUserMsgId: undefined,
          lastMessageAt: Date.now(),
        });
        await this.uploaded(this.meta);
        // Synchronized history and the activation pointer are the native delivery
        // path. The optional dispatch RPC accelerator is unnecessary for correctness.
        return {
          sessionId: session.id,
          userTurnId,
          confirmation: this.confirmation("input"),
        };
      } catch (error) {
        if (error instanceof Fault && error.code === "native_steer_not_applied")
          throw error;
        throw new Fault(
          `${this.mode}_send_uncertain`,
          "Lody input delivery was not fully confirmed; inspect the native turn before retrying",
          "unknown",
          {
            sessionId: session.id,
            userTurnId,
            ...(error instanceof Fault
              ? { cause: error.outcome().error?.code }
              : {}),
          },
        );
      }
    });
  }
  async live(session: Session) {
    return this.connection.live(session);
  }
  async cancel(id: string, turnId: string) {
    const session = await this.get(id);
    await this.connection.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    const native = await this.connection.call(
      session.machineId,
      "session/cancel",
      {
        sessionId: id,
        turnId,
      },
    );
    if (!native?.success)
      throw new Fault(
        "native_error",
        "Lody rejected cancellation",
        "rejected",
        { sessionId: id, turnId, native },
      );
    return { sessionId: id, turnId, interruption: "requested", native };
  }
  async respond(
    input: z.infer<typeof permissionInput>,
    resolvedBy = "agenvo_respond",
  ) {
    return this.use(input.sessionId, async ({ doc, room }) => {
      writePermission(doc, input.turnId, input.requestId, input.outcome);
      try {
        await this.uploaded(room);
      } catch {
        throw new Fault(
          `${this.mode}_response_uncertain`,
          "Lody interaction response was not confirmed",
          "unknown",
          {
            sessionId: input.sessionId,
            turnId: input.turnId,
            requestId: input.requestId,
          },
        );
      }
      this.resolved(
        input.sessionId,
        input.turnId,
        input.requestId,
        input.outcome,
        resolvedBy,
      );
      return {
        sessionId: input.sessionId,
        requestId: input.requestId,
        confirmation: this.confirmation("response"),
        nativeAcknowledged: false,
      };
    });
  }
  private autoEligible(
    request: ReturnType<typeof pendingInteractions>[number],
  ) {
    const p = request.native.permissionRequest;
    // Unknown metadata can describe a user question. Only unambiguous plain
    // execution permissions are answered automatically; all others stay visible.
    return (
      !(p._meta || request.native._meta) &&
      p.options?.some((o: any) => o.kind === "allow_once")
    );
  }
  private announce(
    id: string,
    request: ReturnType<typeof pendingInteractions>[number],
  ) {
    const known = this.announced.get(id) ?? new Set<string>();
    this.announced.set(id, known);
    const key = JSON.stringify([request.turnId, request.requestId]);
    if (known.has(key)) return;
    known.add(key);
    const { permissionRequest, toolCallId, title } = request.native;
    this.publish(
      "lody.interaction.pending",
      id,
      {
        turnId: request.turnId,
        requestId: request.requestId,
        toolCallId,
        title,
        permissionRequest,
      },
      false,
      request.turnId,
    );
  }
  private resolved(
    id: string,
    turnId: string,
    requestId: string,
    outcome: unknown,
    resolvedBy?: string,
  ) {
    this.announced.get(id)?.delete(JSON.stringify([turnId, requestId]));
    this.publish(
      "lody.interaction.resolved",
      id,
      {
        turnId,
        requestId,
        ...(outcome ? { outcome } : {}),
        ...(resolvedBy ? { resolvedBy } : {}),
      },
      false,
      turnId,
    );
  }
  /**
   * Announce requests that need a consumer and report announced ones that are
   * gone. Requests this Connector is about to approve are not announced; the
   * approval reports them instead.
   */
  private scan(id: string, doc: LoroDoc) {
    const pending = pendingInteractions(doc);
    const auto = this.policies.get(id) === "auto_approve_plain";
    for (const request of pending)
      if (!(auto && this.autoEligible(request))) this.announce(id, request);
    const present = new Set(
      pending.map((r) => JSON.stringify([r.turnId, r.requestId])),
    );
    for (const key of [...(this.announced.get(id) ?? [])]) {
      if (present.has(key)) continue;
      const [turnId, requestId] = JSON.parse(key) as [string, string];
      this.resolved(
        id,
        turnId,
        requestId,
        permissionOutcomeOf(doc, turnId, requestId),
      );
    }
  }
  private async approvePermissions(id: string, doc: LoroDoc) {
    for (const request of pendingInteractions(doc)) {
      const p = request.native.permissionRequest;
      const option = p.options?.find((o: any) => o.kind === "allow_once");
      const key = `${id}:${request.turnId}:${request.requestId}`;
      if (!this.autoEligible(request) || this.responding.has(key)) continue;
      this.responding.add(key);
      try {
        const outcome = { outcome: "selected", optionId: option.optionId };
        await this.respond(
          {
            sessionId: id,
            turnId: request.turnId,
            requestId: request.requestId,
            outcome,
          },
          "agenvo_auto_approve",
        );
      } catch {
        // A failed submission stays discoverable, is never replayed here, and
        // now needs the consumer.
        this.announce(id, request);
      } finally {
        this.responding.delete(key);
      }
    }
  }
  async archive(id: string, archived: boolean) {
    const session = await this.get(id);
    await this.connection.machineAccess(
      session.machineId,
      session.project?.kind === "local"
        ? session.project.localProjectId
        : undefined,
    );
    try {
      await this.repo.upsertDocMeta(`session-${id}`, { isArchived: archived });
      await this.uploaded(this.meta);
    } catch {
      throw new Fault(
        `${this.mode}_archive_uncertain`,
        "Lody archival metadata was not confirmed",
        "unknown",
        { sessionId: id },
      );
    }
    return {
      sessionId: id,
      isArchived: archived,
      confirmation: this.confirmation("metadata"),
    };
  }
  async close() {
    this.closed = true;
    this.off?.();
    clearInterval(this.sweeper);
    for (const timer of this.graces.values()) clearTimeout(timer);
    this.graces.clear();
    for (const id of [...this.docs.keys()]) this.drop(id);
    await this.connection.close();
  }
}
