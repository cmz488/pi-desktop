import { readUntil } from "./sse-reader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";

test("HTTP clients keep independent selection, restore committed snapshots, and reject cross-origin writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
  });
  const app = await startDurableDesk({ workspace, port: 0 });
  t.after(() => app.stop());
  const origin = new URL(app.url).origin;
  const post = (path, input, override = {}) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...override,
      },
      body: JSON.stringify(input),
    });
  const create = async (name) =>
    await (
      await post("/api/command", {
        command: "create",
        cwd,
        name,
        model: { provider: faux.provider.id, modelId: faux.models[0].id },
      })
    ).json();
  const one = await create("one"),
    two = await create("two");
  assert.notEqual(one.id, two.id);
  const reads = [],
    read = workspace.read;
  workspace.read = async (id) => {
    if (id !== undefined) reads.push(id);
    return read(id);
  };
  for (const path of [
    "/api/plugins",
    "/api/providers",
    "/api/sessions",
    "/api/agent",
  ])
    assert.equal(
      (await fetch(origin + `${path}?sessionId=${one.id}`)).status,
      200,
    );
  assert.deepEqual(
    reads,
    [],
    "resource listings must not project the conversation transcript",
  );
  const oneView = await (
    await fetch(origin + `/api/state?id=${one.id}`)
  ).json();
  const twoView = await (
    await fetch(origin + `/api/state?id=${two.id}`)
  ).json();
  assert.equal(oneView.active.name, "one");
  assert(
    reads.includes(one.id),
    "chat state still includes its committed transcript",
  );
  assert.equal(twoView.active.name, "two");
  assert.equal(
    (
      await post(
        "/api/command",
        { command: "create", cwd },
        { Origin: "https://example.invalid" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post("/api/command", {
        command: "import-private-file",
        path: "/etc/passwd",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post("/api/command", {
        command: "configure",
        id: one.id,
        revision: 999,
        name: "stale",
      })
    ).status,
    409,
  );
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(origin + "/api/events", {
    signal: controller.signal,
  });
  const reader = events.body.getReader();
  assert(
    (await readUntil(reader, "resync_required")).includes("resync_required"),
  );
  faux.setResponses([fauxAssistantMessage("served")]);
  const response = await post("/api/command", {
    command: "send",
    id: one.id,
    message: "hello",
    requestId: "http-send",
  });
  assert.equal(response.status, 200);
  assert((await readUntil(reader, "state_changed")).includes("state_changed"));
  await reader.cancel();
  assert.equal((await fetch(origin + "/")).status, 200);
  assert.equal((await fetch(origin + "/../auth.json")).status, 404);
  assert(
    (await (await fetch(origin + `/api/state?id=${two.id}`)).json()).active
      .messages.length === 0,
  );
});

test("model and thinking changes queued during a run apply after the run becomes idle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-deferred-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const models = createModels();
  const faux = fauxProvider({
    models: [
      { id: "first", reasoning: true, input: ["text"] },
      { id: "second", reasoning: true, input: ["text"] },
    ],
  });
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
  });
  const app = await startDurableDesk({ workspace, cwd, port: 0 });
  t.after(() => app.stop());
  const origin = new URL(app.url).origin;
  const agent = (await workspace.read()).agents[0];
  let releaseResponse,
    providerStarted = false;
  t.after(() => releaseResponse?.());
  faux.setResponses([
    async () => {
      providerStarted = true;
      return new Promise((resolve) => {
        releaseResponse = () => resolve(fauxAssistantMessage("finished"));
      });
    },
  ]);
  const post = (path, input) => {
    const url = new URL(path, origin);
    url.searchParams.set("sessionId", String(agent.id));
    return fetch(url, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, sessionId: String(agent.id) }),
    });
  };
  const getState = async () =>
    await (await fetch(`${origin}/api/state?sessionId=${agent.id}`)).json();
  const prompt = await post("/api/prompt", {
    message: "hold this request while I change the next model",
    requestId: "deferred-model-config",
  });
  assert.equal(prompt.status, 200);
  for (let attempt = 0; attempt < 100 && !providerStarted; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert(providerStarted, "the model request should be in flight");
  assert.equal((await getState()).idle, false);

  const modelResponse = await post("/api/model", {
    provider: faux.provider.id,
    id: "second",
  });
  assert.equal(modelResponse.status, 200);
  assert.equal((await modelResponse.json()).deferred, true);
  const thinkingResponse = await post("/api/thinking", { level: "high" });
  assert.equal(thinkingResponse.status, 200);
  assert.equal((await thinkingResponse.json()).deferred, true);
  const queued = await getState();
  assert.equal(queued.configurationPending, true);
  assert.equal(queued.model.id, "second");
  assert.equal(queued.thinkingLevel, "high");

  releaseResponse();
  let finished;
  for (let attempt = 0; attempt < 200; attempt++) {
    finished = await getState();
    if (finished.idle && !finished.configurationPending) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finished.idle, true);
  assert.equal(finished.configurationPending, false);
  assert.equal(finished.active.model.modelId, "second");
  assert.equal(finished.active.thinkingLevel, "high");
});

test("an IPv6 loopback listener returns a reachable local URL", async (t) => {
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models: createModels(),
  });
  const app = await startDurableDesk({ workspace, host: "::1", port: 0 });
  t.after(() => app.stop());
  assert.equal(new URL(app.url).hostname, "[::1]");
  const response = await fetch(new URL("api/remote", app.url));
  assert.equal(response.status, 200);
  const details = await response.json();
  assert.equal(details.localUrl, app.url);
  assert.equal(details.lan, false);
  assert(details.qr.startsWith("data:image/png;base64,"));
});
