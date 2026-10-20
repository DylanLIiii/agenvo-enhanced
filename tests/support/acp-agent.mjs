// Minimal ACP agent for isolated Lody tests. It stands in for providers that
// need accounts. Every request it receives is appended to $ACP_MOCK_LOG so tests
// can observe what the native daemon actually dispatched.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) =>
  appendFileSync(process.env.ACP_MOCK_LOG, JSON.stringify(entry) + "\n");
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const state = { mode: "default", model: "mock-small", options: {} };
const pending = new Map();
let nextId = 1;
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
const configOptions = () => [
  {
    id: "permission_mode",
    name: "Permission",
    category: "_permission",
    type: "select",
    currentValue: state.options.permission_mode ?? "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "always-approve", name: "Always approve" },
    ],
  },
];
const modes = () => ({
  currentModeId: state.mode,
  availableModes: [
    { id: "default", name: "Default" },
    { id: "yolo", name: "Yolo" },
  ],
});
const models = () => ({
  currentModelId: state.model,
  availableModels: [
    { modelId: "mock-small", name: "Small" },
    { modelId: "mock-large", name: "Large" },
  ],
});

async function handle(id, method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        authMethods: [],
      };
    case "session/new":
      return {
        sessionId: "mock-session",
        modes: modes(),
        models: models(),
        configOptions: configOptions(),
      };
    case "session/set_mode":
      state.mode = params.modeId;
      return {};
    case "session/set_model":
      state.model = params.modelId;
      return {};
    case "session/set_config_option":
      state.options[params.configId] = params.value;
      return { configOptions: configOptions() };
    case "session/prompt": {
      const text = params.prompt?.map((p) => p.text ?? "").join("") ?? "";
      // LONG_RUN<ms> keeps the turn running so tests can observe long executions.
      const long = /LONG_RUN(\d+)/.exec(text);
      // It streams a chunk every two seconds while running.
      if (long)
        for (let left = Number(long[1]); left > 0; left -= 2000) {
          await new Promise((r) => setTimeout(r, Math.min(2000, left)));
          write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "." },
              },
            },
          });
        }
      let permission;
      if (text.includes("NEEDS_PERMISSION")) {
        permission = await ask("session/request_permission", {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: "mock-tool",
            title: "Run mock command",
            kind: "execute",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        log({ permission });
      }
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `MOCK_ACP_RESULT mode=${state.mode} model=${state.model} permission=${state.options.permission_mode ?? "ask"}`,
            },
          },
        },
      });
      return { stopReason: "end_turn" };
    }
    default:
      return {};
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  log({ method: message.method, params: message.params });
  if (message.id === undefined) return;
  write({
    jsonrpc: "2.0",
    id: message.id,
    result: await handle(message.id, message.method, message.params),
  });
});
