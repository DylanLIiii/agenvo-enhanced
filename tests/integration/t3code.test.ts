import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { t3codeFixture } from "../fixtures/t3code-server.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { writeToken } from "../../apps/t3code/src/config.js";

test(
  "T3 Code orchestration tools cross Relay MCP with native errors and uncertain receipts",
  { timeout: 30000 },
  async (t) => {
    const lab = await eventsLab(t);
    const native = await t3codeFixture();
    lab.cleanup(native.close);
    const instance = {
      id: "t3",
      label: "T3 Code",
      kind: "t3code" as const,
      endpoint: native.endpoint,
      tokenFile: join(lab.root, "t3code-token.json"),
    };
    await writeToken(instance, { accessToken: native.issue(), clientId: "c" });
    const device = await lab.connect([instance]);
    const outcome = async (method: string, params = {}) =>
      nativeOutcome(
        await lab.rpc("tools/call", {
          name: "execute",
          arguments: callCode({
            deviceId: device,
            instanceId: "t3",
            method,
            params,
          }),
        }),
      );
    const call = (method: string, params = {}) =>
      lab.call(device, "t3", method, params);

    const found = await lab.rpc("tools/call", {
      name: "search",
      arguments: {
        query: "submit input",
        deviceId: device,
        includeSchema: true,
      },
    });
    const text = JSON.stringify(found);
    assert.match(text, /t3_thread_send/);
    assert.doesNotMatch(text, /preview_open|delegate_task/);

    const threads = await call("t3_thread_list", { projectId: "project-1" });
    assert.equal(threads.threads[0].threadId, "thread-external");
    const threadId = threads.threads[0].threadId;
    await call("t3_thread_send", {
      threadId,
      message: "Continue external thread",
    });
    assert.equal(
      (await call("t3_thread_wait", { threadId, timeoutMs: 1000 })).status,
      "completed",
    );
    assert.match(
      JSON.stringify(await call("t3_thread_read", { threadId })),
      /FIXTURE_OUTPUT/,
    );
    const questions = await call("t3_pending_request", {
      action: "list",
      threadId,
    });
    await call("t3_pending_request", {
      action: "respond",
      threadId,
      requestId: questions.requests[0].requestId,
      answers: { answer: "Proceed" },
    });

    const rejected = await outcome("t3_thread_send", {
      threadId: "missing",
      message: "x",
    });
    assert.equal(rejected.execution, "rejected");
    assert.equal(rejected.error.message, "Fixture target not found");
    const hidden = await outcome("preview_open", {
      url: "https://example.com",
    });
    assert.equal(hidden.execution, "not_started");

    const count = native.calls.filter(
      (c) => c.name === "t3_thread_send",
    ).length;
    native.dropNextCall();
    const lost = await outcome("t3_thread_send", {
      threadId,
      message: "Uncertain",
    });
    assert.equal(lost.execution, "unknown");
    assert.ok(lost.requestId);
    assert.equal(lost.nativeIds.threadId, threadId);
    await lab.restartConnector(device);
    assert.equal(
      native.calls.filter((c) => c.name === "t3_thread_send").length,
      count + 1,
    );
    assert.equal((await call("t3_thread_list", {})).threads.length, 1);
  },
);
