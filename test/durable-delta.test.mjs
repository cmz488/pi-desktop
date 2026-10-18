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

// A streamed answer used to rebuild the whole workspace projection on every
// commit and broadcast it as state_changed, so the page fetched a full chat
// snapshot for every token batch. The delta window must keep streamed text
// flowing through assistant updates while a full read stays rare.
test("a streamed answer publishes deltas without rebuilding the workspace per commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-delta-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1000 });
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
  });
  let reads = 0,
    liveCalls = 0;
  const read = workspace.read;
  workspace.read = async (id) => {
    reads++;
    return read(id);
  };
  const live = workspace.live;
  workspace.live = async (id) => {
    liveCalls++;
    return live(id);
  };
  const app = await startDurableDesk({ workspace, port: 0 });
  t.after(() => app.stop());
  const origin = new URL(app.url).origin;
  const post = (path, input) =>
    fetch(origin + path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  const created = await (
    await post("/api/command", {
      command: "create",
      cwd,
      name: "Delta",
      model: { provider: faux.provider.id, modelId: faux.models[0].id },
    })
  ).json();

  const kinds = [];
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${origin}/api/events?id=${created.id}`, {
    signal: controller.signal,
  });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const wire = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = wire
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) kinds.push(JSON.parse(data.slice(6)).kind);
        }
      }
    } catch {
      /* the test closes the stream on purpose */
    }
  })();

  faux.setResponses([fauxAssistantMessage("streamed answer ".repeat(200))]);
  reads = 0;
  liveCalls = 0;
  assert.equal(
    (
      await post("/api/command", {
        command: "send",
        id: created.id,
        message: "stream this",
        requestId: "delta-stream",
      })
    ).status,
    200,
  );

  const deadline = Date.now() + 20000;
  let idle = false;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Poll idle through the cheap live projection so the measurement is not
    // polluted by the test's own full reads.
    const state = await workspace.live(created.id);
    if (state.idle && state.entryCount > 1) {
      idle = true;
      break;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  const sampledReads = reads;
  const updates = kinds.filter((kind) => kind === "assistant_update").length;
  const structural = kinds.filter((kind) => kind === "state_changed").length;
  controller.abort();
  await pump;
  const state = await (
    await fetch(`${origin}/api/state?id=${created.id}`)
  ).json();

  assert.equal(idle, true, "the streamed answer must finish");
  assert.equal(state.idle, true, "the host must report the agent as idle");
  assert(
    state.messages.some((row) => row.text.includes("streamed answer")),
    "the committed answer must be in the transcript",
  );
  assert(
    updates >= 1,
    "streamed text must reach the page as assistant updates",
  );
  assert(
    sampledReads <= 20,
    `a streamed answer rebuilt the workspace ${sampledReads} times`,
  );
  assert(
    structural <= 6,
    `a streamed answer broadcast ${structural} full refreshes`,
  );
  assert(
    liveCalls > updates,
    "delta windows must use the cheap live projection",
  );
});
