import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableModels } from "../src/agent/durable-models.mjs";

test("embedded models reuse Pi custom providers without exposing secrets or writing inherited configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    directory = join(root, "desk");
  await mkdir(agentDir);
  const inherited = JSON.stringify({
    providers: {
      local: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8/v1",
        apiKey: "never-return-this",
        models: [{ id: "model", reasoning: true }],
      },
    },
  });
  await writeFile(join(agentDir, "models.json"), inherited);
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      openai: { type: "api_key", key: "private-inherited-key" },
    }),
  );
  const app = await openDurableModels({ agentDir, directory });
  const list = await app.inventory();
  assert(!JSON.stringify(list).includes("never-return-this"));
  assert(
    (await app.models.getAvailable()).some(
      (row) => row.provider === "local" && row.id === "model",
    ),
  );
  assert(
    (await app.models.getAuth("openai")).auth.apiKey ===
      "private-inherited-key",
  );
  await app.save({
    id: "local",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    modelId: "new-model",
    apiKey: "new-private-key",
    revision: list.revision,
  });
  assert.equal(
    await readFile(join(agentDir, "models.json"), "utf8"),
    inherited,
  );
  assert.equal(
    (await app.models.getAuth("local")).auth.apiKey,
    "new-private-key",
  );
  assert(!JSON.stringify(await app.inventory()).includes("new-private-key"));
  await assert.rejects(app.save({ id: "x", revision: list.revision }), /变化/);
  await assert.rejects(
    app.save({
      id: "x",
      api: "openai-completions",
      baseUrl: "http://user:password@example.invalid",
      modelId: "x",
      revision: (await app.inventory()).revision,
    }),
    /端点/,
  );
});
