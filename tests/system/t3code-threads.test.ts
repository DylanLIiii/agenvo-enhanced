import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { binary } from "@agenvo/connector/cli/binary";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { nativeT3Code, approveSignIn } from "../support/t3code-native.js";
import { isolatedEnvironment, until } from "../support/environment.js";
import { callCode, nativeOutcome } from "../support/code.js";
import { login } from "../../apps/t3code/src/login.js";
import { instanceConfigSchema } from "../../apps/t3code/src/config.js";

test(
  "T3 Code outside-agent sign-in drives native threads through Relay MCP and survives connector restart",
  { timeout: 300000 },
  async (t) => {
    try {
      await binary("t3", {});
      await binary("codex", {});
    } catch {
      t.skip("t3 or codex is not installed; install the pinned test runtimes");
      return;
    }
    const lab = await eventsLab(t);
    const model = await modelServer(() => "T3_ISOLATED_MODEL_RESULT");
    lab.cleanup(() => model.close());
    const native = await nativeT3Code(
      lab.root,
      model.config["model_providers.fixture.base_url"],
    );
    lab.cleanup(native.close);
    const project = join(lab.root, "project");
    await mkdir(project);
    const git = (args: string[]) =>
      promisify(execFile)("git", args, {
        cwd: project,
        env: isolatedEnvironment(lab.root),
      });
    await git(["init"]);
    await writeFile(join(project, "fixture.txt"), "fixture");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "fixture",
    ]);

    const instance = instanceConfigSchema.parse({
      id: "t3",
      label: "T3 Code",
      kind: "t3code",
      endpoint: native.endpoint,
      tokenFile: join(lab.root, "t3code-token.json"),
    });
    // Sign in exactly as `instance add` does; the owner approves with a
    // pairing code on the environment's own approval endpoint.
    const pairingCode = await native.pairingCode();
    const signedIn = await login(instance, {
      browser: false,
      announce: (url) => {
        void approveSignIn(native.origin, url, pairingCode).then((redirect) =>
          fetch(redirect),
        );
      },
    });
    assert.match(signedIn.scope ?? "", /orchestration:operate/);

    const device = await lab.connect([instance]);
    const call = (method: string, params = {}) =>
      lab.call(device, "t3", method, params);
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

    const search = JSON.stringify(
      await lab.rpc("tools/call", {
        name: "search",
        arguments: { query: "t3_", deviceId: device },
      }),
    );
    assert.match(search, /t3_thread_launch/);
    assert.doesNotMatch(search, /preview_open|delegate_task|html_render/);

    // A project and thread created outside Agenvo, by the T3 Code CLI.
    await native.cli(["project", "add", project]);
    const projects = await call("t3_project_list");
    const projectId = projects.projects.find(
      (p: any) => p.workspaceRoot === project,
    ).id;
    const capabilities = await call("orchestrator_capabilities");
    const codex = capabilities.providers.find(
      (p: any) => p.driverKind === "codex",
    );
    assert.ok(codex, JSON.stringify(capabilities));

    const launched = await outcome("t3_thread_launch", {
      title: "Agenvo system test",
      projectId,
      message: "Reply with the fixture result.",
      modelSelection: {
        instanceId: codex.providerInstanceId,
        model: "fixture",
      },
    });
    assert.equal(launched.execution, "accepted", JSON.stringify(launched));
    const threadId = launched.result.threadId;
    assert.ok(threadId);
    const finished = await until(
      () => call("t3_thread_wait", { threadId, timeoutMs: 5000 }),
      (r: any) =>
        !["queued", "starting", "running", "preparing"].includes(r.status),
      120000,
    );
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    assert.match(
      JSON.stringify(await call("t3_thread_read", { threadId, limit: 10 })),
      /T3_ISOLATED_MODEL_RESULT/,
    );

    // The environment keeps the thread when the Connector restarts; input is
    // never replayed.
    const before = model.requests.length;
    await lab.restartConnector(device);
    assert.equal(model.requests.length, before);
    const listed = await call("t3_thread_list", { projectId });
    assert.ok(
      listed.threads.some(
        (x: any) => x.id === threadId || x.threadId === threadId,
      ),
    );
    await call("t3_thread_send", {
      threadId,
      message: "Continue once more.",
    });
    await until(
      () => call("t3_thread_wait", { threadId, timeoutMs: 5000 }),
      (r: any) => r.status === "completed" && model.requests.length > before,
      120000,
    );

    const rejected = await outcome("t3_thread_send", {
      threadId: "missing-thread",
      message: "x",
    });
    assert.equal(rejected.execution, "rejected");
  },
);
