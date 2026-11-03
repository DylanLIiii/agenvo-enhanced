import type { Method } from "@agenvo/connector/adapters/adapter";

/**
 * Orchestration tools reachable through Agenvo, with the shared discovery
 * terms. Names, input schemas, read-only hints and native descriptions come
 * from the environment's own `tools/list`; this table only selects tools and
 * adds the terms other Connectors use for the same intent.
 *
 * Tools bound to the calling T3 thread or to its local surfaces (preview,
 * devices, HTML rendering, delegation, worktree handoff, attachments,
 * scheduling, secrets, pull request watches) are not exposed: outside the
 * environment they either have no current thread or no human surface.
 */
export const exposed: Record<string, string> = {
  orchestrator_capabilities:
    "List native providers, models, model options and runtime modes available for new threads.",
  t3_environment_read: "Read native environment identity and preferences.",
  t3_project_list: "List native projects (work context containers).",
  t3_project_read: "Read one native project with its workspace and scripts.",
  t3_project_create:
    "Create a native project for a folder on the T3 Code host. Does not start a thread.",
  t3_project_update: "Update native project settings.",
  t3_project_delete:
    "Delete a native project registration; folders on disk stay.",
  t3_project_clone:
    "Clone a repository on the T3 Code host; register it with t3_project_create.",
  t3_thread_list:
    "List work contexts (native threads) in a project, including threads other clients started.",
  t3_thread_search:
    "Search work contexts (native threads) by title, branch, project or message text.",
  t3_thread_read:
    "Read output and input from a native thread: messages, plans or activity, with native paging.",
  t3_thread_launch:
    "Create work context: start a native thread in a project, optionally with its first input. Runs are bounded by the access ceiling granted to Agenvo.",
  t3_thread_send:
    "Submit input to an existing native thread. Native mode decides whether it starts, steers, queues or restarts a run. Acceptance does not establish task success.",
  t3_thread_wait:
    "Wait for a native thread run and read its native status. Agenvo calls stop after 10 seconds; pass a shorter native timeoutMs and call again. Completion does not establish task success.",
  t3_thread_interrupt:
    "Interrupt the running turn of a native top-level thread.",
  t3_thread_update: "Rename a native thread or regenerate its title.",
  t3_thread_configure:
    "Read or set the provider, model and options of a native thread.",
  t3_thread_organize:
    "Pin, snooze, settle, archive or mark a native thread unread.",
  t3_thread_transfer:
    "Fork a native thread or merge its context into another thread.",
  t3_pending_request:
    "List, read or respond to native pending user questions (requests) in a thread. Permission approvals are not answered here.",
  t3_queue:
    "List, edit, cancel, reorder or promote queued native input of a thread.",
};

export type NativeTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

/** Tools absent from this environment simply do not appear. */
export function methodsFrom(tools: NativeTool[]): Method[] {
  return tools
    .filter((tool) => Object.hasOwn(exposed, tool.name))
    .map((tool) => ({
      name: tool.name,
      description:
        `${exposed[tool.name]} Native: ${tool.description ?? ""}`.trim(),
      // Unannotated tools are treated as writes so lost responses stay uncertain.
      readOnly: tool.annotations?.readOnlyHint === true,
      inputSchema: tool.inputSchema,
    }));
}
