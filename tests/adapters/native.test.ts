import { codexServer } from "../support/codex-server.js";
import { socketTempDir } from "../support/environment.js";
import { binary } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { CodexAdapter } from "../../apps/codex-app-server/src/codex.js";
import { instanceConfigSchema } from "../support/config.js";
const executable = (name: string) => binary(name, {});

test("Codex native API creates full-access threads without a model turn", async (t) => {
  const home = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-codex-")),
  );
  const native = await codexServer(home, await executable("codex"));
  const cfg = instanceConfigSchema.parse({
    kind: "codex",
    id: "coding",
    label: "Test",
    endpoint: native.endpoint,
    cwd: home,
    home,
  });
  if (cfg.kind !== "codex") throw new Error();
  const adapter = new CodexAdapter(cfg);
  t.after(async () => {
    await adapter.close();
    await native.close();
    await rm(home, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await adapter.init();
  assert.equal(adapter.available, true);
  for (const historyMode of ["legacy", "paginated"]) {
    const created: any = (
      await adapter.call("thread/start", { historyMode, ephemeral: false })
    ).result;
    assert.ok(created.thread.id);
    assert.equal(created.approvalPolicy, "never");
    assert.equal(created.sandbox.type, "dangerFullAccess");
    try {
      const history = await adapter.call("thread/read", {
        threadId: created.thread.id,
        includeTurns: true,
      });
      assert.equal((history.result as any).thread.id, created.thread.id);
      t.diagnostic(historyMode + " history read succeeded");
    } catch (error: any) {
      assert.equal(error.code, "native_error");
      assert.match(
        JSON.stringify(error.native),
        /not supported|not found|no rollout|not materialized/i,
      );
      t.diagnostic(
        historyMode +
          " history is unavailable for an empty thread: " +
          JSON.stringify(error.native),
      );
    }
  }
  await assert.rejects(
    adapter.call("requests.respond", { interactionId: "old", result: {} }),
    { code: "interaction_expired" },
  );
});
