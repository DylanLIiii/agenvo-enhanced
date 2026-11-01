import { z } from "zod";

const terminal = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "Native terminal address or name, including machine/address for a connected machine.",
  );
const strings = z.record(z.string(), z.string());
const target = { terminal };
const definition = (
  schema: z.ZodType,
  readOnly: boolean,
  description: string,
) => ({ schema, readOnly, description });

export const methods = {
  "terminal.list": definition(
    z.strictObject({ all: z.boolean().optional(), labels: strings.optional() }),
    true,
    "List work contexts as native terminals, including those created outside Agenvo and on connected machines. Use all to include finished terminals; inspect machines for disconnected or unavailable remote machines.",
  ),
  "terminal.get": definition(
    z.strictObject(target),
    true,
    "Read a terminal's native metadata, program-reported status and exit state. Missing status means the program has not reported one; it is not task success.",
  ),
  "terminal.run": definition(
    z.strictObject({
      argv: z.array(z.string()).max(64).optional(),
      line: z.string().max(48000).optional(),
      name: z.string().optional(),
      cwd: z.string().optional(),
      env: strings.optional(),
      labels: strings.optional(),
      on: z.string().optional(),
      parent: z.string().optional(),
      no_parent: z.boolean().optional(),
      outlive_parent: z.boolean().optional(),
      no_notify: z.boolean().optional(),
      keep: z.boolean().optional(),
      rm: z.boolean().optional(),
    }),
    false,
    "Create work context by starting a program or template in a new terminal. argv and execution settings pass to Herdr Core unchanged. A template may send its first message before returning; inspect first_message. After an unknown result inspect terminal.list before retrying.",
  ),
  "terminal.read": definition(
    z.strictObject({
      ...target,
      lines: z.number().int().min(0).max(500).optional(),
    }),
    true,
    "Read output as the native terminal screen and optional history. The result includes text, complete, how and why; it is not a durable conversation transcript.",
  ),
  "terminal.send": definition(
    z.strictObject({
      ...target,
      text: z.string().max(48000),
      force: z.boolean().optional(),
      if: z.enum(["idle", "working"]).optional(),
    }),
    false,
    "Submit input by pasting text and pressing Enter. Core refuses blocked programs unless force is set; use it only when answering the displayed request. Acceptance does not prove completion.",
  ),
  "terminal.keys": definition(
    z.strictObject({
      ...target,
      keys: z.array(z.string().min(1).max(64)).min(1).max(64),
    }),
    false,
    "Submit input as native keys, such as enter, esc or ctrl+c, to respond or interrupt. The effect depends on the terminal program.",
  ),
  "terminal.interrupt": definition(
    z.strictObject({ ...target, timeout: z.number().min(0).max(5).default(3) }),
    false,
    "Interrupt by sending the native stop key and report the observed effect; it does not escalate or establish task success. Observation defaults to 3 seconds to fit the Relay deadline.",
  ),
  "terminal.kill": definition(
    z.strictObject(target),
    false,
    "End a terminal program, escalating from hangup to kill. Preserve needed output first.",
  ),
  "terminal.rm": definition(
    z.strictObject(target),
    false,
    "Remove a finished terminal and its retained record.",
  ),
  "terminal.keep": definition(
    z.strictObject({ ...target, keep: z.boolean() }),
    false,
    "Set whether a lost terminal is recovered as a fresh shell; the original command is never rerun.",
  ),
  "terminal.label": definition(
    z.strictObject({ ...target, labels: strings }),
    false,
    "Set or remove native terminal labels; an empty value removes a label.",
  ),
  "templates.list": definition(
    z.strictObject({}),
    true,
    "List native templates available to terminal.run.",
  ),
  "machine.list": definition(
    z.strictObject({}),
    true,
    "List machines already connected to this Herdr Core; their terminals are included in terminal.list.",
  ),
  "machine.connect": definition(
    z.strictObject({ machine: z.string().min(1).max(256) }),
    false,
    "Dial an already registered machine now instead of at its next retry, such as after a login. It does not add a machine or change its configuration. Native dialing waits up to 30 seconds; past this connector's socket wait the call returns unknown, so read machine.list for the current state.",
  ),
  "server.status": definition(
    z.strictObject({}),
    true,
    "Read this Herdr Core's native identity, version, pid, uptime and terminal counts, including every holder. Holder and counts describe the shared Core, not one agent's task.",
  ),
  "machine.exec": definition(
    z.strictObject({
      argv: z.array(z.string()).max(64).optional(),
      line: z.string().max(48000).optional(),
      cwd: z.string().optional(),
      env: strings.optional(),
      input: z.string().optional(),
      on: z.string().optional(),
      timeout: z.number().min(0).max(600).optional(),
    }),
    false,
    "Run one program here or on a connected machine without a terminal: argv runs as given, line runs in that machine's shell. It returns the exit code and stdout/stderr as base64; a nonzero exit or timeout is a result, not an error. Everything it starts ends with it, at its exit, at timeout (native default 60 seconds), or when the caller leaves. This is not a work context: no address, output screen or events. A run past this connector's 8.5-second wait returns unknown and Core ends the program with its caller, so use terminal.run for long work.",
  ),
  "file.read": definition(
    z.strictObject({
      path: z.string().min(1),
      cwd: z.string().optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(0).optional(),
      on: z.string().optional(),
    }),
    true,
    "Read a text file here or on a connected machine, from line offset, at most limit lines. The result reports the first and last line given and the file's total lines; relative paths start at cwd. Native Core allows 8 MB, but this connector's frame is 64 KB: read a large file in parts with offset and limit, or the result is refused as too large.",
  ),
  "file.write": definition(
    z.strictObject({
      path: z.string().min(1),
      data: z.string().max(45000),
      cwd: z.string().optional(),
      on: z.string().optional(),
    }),
    false,
    "Replace a whole file here or on a connected machine, creating missing folders. data is the complete content as base64, at most about 33 KB of file after base64 and this connector's 64 KB frame; larger files need file.edit or another transport. A reader sees the old or new file, never a partial one; an existing file keeps its mode and a symlink is followed. Read the previous content first: this overwrites it.",
  ),
  "file.edit": definition(
    z.strictObject({
      path: z.string().min(1),
      edits: z
        .array(z.strictObject({ old: z.string(), new: z.string() }))
        .min(1)
        .max(64),
      cwd: z.string().optional(),
      on: z.string().optional(),
    }),
    false,
    "Replace exact text in a file here or on a connected machine. Each old must occur exactly once in the file as it was, and edits must not overlap; all are made or none. No fuzzy or regular-expression matching. The whole request must fit this connector's 64 KB frame.",
  ),
} satisfies Record<
  string,
  { schema: z.ZodType; readOnly: boolean; description: string }
>;
