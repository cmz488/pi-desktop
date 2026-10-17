import { test } from "node:test";
import assert from "node:assert/strict";
import { startWeb } from "../src/server/web.mjs";
import { concurrentFixture, until } from "./concurrent-fixture.mjs";

test("concurrent cold restore opens only one historical writer", async (t) => {
  const model = await concurrentFixture();
  let app;
  t.after(async () => {
    await app?.stop();
    await model.stop();
  });
  app = await startWeb({
    cwd: model.root,
    agentDir: model.agentDir,
    port: 0,
    noExtensions: true,
  });
  await app.ready;
  const aid = app.runtime.session.sessionManager.getSessionId();
  const running = app.runtime.session.prompt("TASK A");
  await until(() => model.entered.has("A"));
  model.release("A");
  await running;
  await app.stop();
  app = await startWeb({
    cwd: model.root,
    agentDir: model.agentDir,
    port: 0,
    noExtensions: true,
  });
  await app.ready;
  let opened = 0;
  const create = app.manager.createSlot;
  app.manager.createSlot = (options) => {
    if (options.path) opened++;
    return create(options);
  };
  const origin = new URL(app.url).origin;
  const select = () =>
    fetch(origin + "/api/switch-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: aid }),
    });
  const responses = await Promise.all([select(), select()]);
  for (const response of responses)
    assert.equal(response.status, 200, await response.text());
  assert.equal(opened, 1, "a history file must have only one SDK writer");
  assert.equal(app.manager.slots.size, 2);
  assert.equal(app.manager.focusId, aid);
  assert(
    app.runtime.session.messages.some((row) =>
      JSON.stringify(row.content).includes("completed-A"),
    ),
  );
});

async function fixture(t) {
  const model = await concurrentFixture();
  const app = await startWeb({
    cwd: model.root,
    agentDir: model.agentDir,
    port: 0,
    noExtensions: true,
  });
  await app.ready;
  t.after(async () => {
    await app.stop();
    await model.stop();
  });
  const origin = new URL(app.url).origin;
  const state = async () => (await fetch(origin + "/api/state")).json();
  const post = (path, data = {}) =>
    fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const call = async (path, data) => {
    const response = await post(path, data);
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  };
  return { model, app, origin, state, post, call };
}

test("running A survives creation and simultaneous B; switching reuses writers and events carry session IDs", async (t) => {
  const f = await fixture(t);
  const a = f.app.runtime.session;
  a.setActiveToolsByName(["read"]);
  const first = await f.state();
  const events = [];
  const controller = new AbortController();
  const response = await fetch(
    f.origin + `/api/events?epoch=${first.epoch}&after=${first.seq}`,
    { signal: controller.signal },
  );
  const reading = (async () => {
    let buffer = "";
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        buffer += new TextDecoder().decode(part.value);
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const wire = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = wire
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  t.after(async () => {
    controller.abort();
    await reading;
  });
  await f.call("/api/prompt", {
    message: "TASK A",
    sessionId: first.sessionId,
  });
  await until(() => f.model.entered.has("A"));
  const created = await f.call("/api/prompt", {
    message: "/sessions new",
    sessionId: first.sessionId,
  });
  assert.equal(created.sessionCommand.action, "new");
  await f.app.manager.active.app.ready;
  const b = f.app.runtime.session;
  const second = await f.state();
  assert.notEqual(second.sessionId, first.sessionId);
  assert.notEqual(a, b);
  assert.equal(a.isIdle, false);
  assert.deepEqual(
    second.tools,
    ["read"],
    "a managed child must not expand the parent's tool loadout",
  );
  assert.equal(second.backend.id, first.backend.id);
  assert.equal(second.epoch, first.epoch);
  await f.call("/api/prompt", {
    message: "TASK B",
    sessionId: second.sessionId,
  });
  await until(() => f.model.entered.has("B"));
  await until(
    () =>
      events
        .filter((event) => event.kind === "assistant_update")
        .some((event) => event.data.sessionId === first.sessionId) &&
      events.some(
        (event) =>
          event.kind === "assistant_update" &&
          event.data.sessionId === second.sessionId,
      ),
  );
  const list = await (await fetch(f.origin + "/api/sessions")).json();
  assert(list.rows.some((row) => row.id === first.sessionId && row.running));
  assert(list.rows.some((row) => row.id === second.sessionId && row.running));
  await f.call("/api/prompt", {
    message: `/sessions use ${first.sessionId.slice(0, 18)}`,
  });
  assert.equal(f.app.runtime.session, a);
  const listed = await f.call("/api/prompt", { message: "/sessions list" });
  assert.equal(
    listed.sessionCommand.rows.filter((row) => row.running).length,
    2,
  );
  assert.equal(
    (await f.post("/api/abort", { sessionId: second.sessionId })).status,
    409,
  );
  assert.equal(a.isIdle, false);
  assert.equal(b.isIdle, false);
  await f.call("/api/switch-session", { id: second.sessionId });
  assert.equal(f.app.runtime.session, b);
  f.model.release("A");
  await until(() => a.isIdle);
  const stillB = await f.state();
  assert.equal(stillB.sessionId, second.sessionId);
  assert(!stillB.messages.some((row) => row.text.includes("completed-A")));
  f.model.release("B");
  await until(() => b.isIdle);
  assert(a.messages.some((message) => message.role === "toolResult"));
  assert(b.messages.some((message) => message.role === "toolResult"));
  assert(
    a.messages.some((message) =>
      JSON.stringify(message.content).includes("completed-A"),
    ),
  );
  assert(
    b.messages.some((message) =>
      JSON.stringify(message.content).includes("completed-B"),
    ),
  );
  await f.call("/api/switch-session", { id: first.sessionId });
  assert.equal(f.app.runtime.session, a);
});

test("HTTP stop cancels pending interaction in the selected SDK slot", async (t) => {
  const f = await fixture(t);
  const store = f.app.manager.active.options.interactions;
  const jobId = store.start("local-dialog", async (ui) => {
    try {
      await ui.prompt({
        type: "text",
        message: "fixture dialog",
        secret: true,
      });
    } catch {
      /* Explicit cancellation is the fixture outcome. */
    }
  });
  await until(() => store.list().find((row) => row.id === jobId)?.prompt);
  const id = f.app.manager.focusId;
  await f.call("/api/abort", { sessionId: id });
  await until(
    () => store.list().find((row) => row.id === jobId)?.status === "cancelled",
  );
  assert.equal(f.app.manager.focusId, id);
  assert.equal(f.app.runtime.session.isIdle, true);
  assert.equal(f.app.runtime.session.messages.length, 0);
});

test("stopping selected A does not abort B; shutdown drains all slots", async (t) => {
  const f = await fixture(t);
  const a = f.app.runtime.session;
  const aid = (await f.state()).sessionId;
  await f.call("/api/prompt", { message: "TASK A" });
  await until(() => f.model.entered.has("A"));
  await f.call("/api/new-session", {});
  await f.app.manager.active.app.ready;
  const b = f.app.runtime.session;
  const bid = (await f.state()).sessionId;
  await f.call("/api/prompt", { message: "TASK B" });
  await until(() => f.model.entered.has("B"));
  await f.call("/api/prompt", {
    message: `/sessions stop ${aid.slice(0, 18)}`,
    sessionId: bid,
  });
  await until(() => a.isIdle);
  assert.equal(b.isIdle, false);
  assert.equal(f.app.manager.focusId, bid);
  const bad = await f.post("/api/prompt", {
    message: "/sessions use a",
    sessionId: bid,
  });
  assert.equal(bad.status, 422);
  assert.equal(f.app.manager.focusId, bid);
  assert(!b.messages.some((row) => JSON.stringify(row).includes("/sessions")));
  await f.app.stop();
  assert.equal(b.isIdle, true);
  assert.equal(f.app.manager.slots.size, 0);
  await assert.rejects(fetch(f.origin + "/api/state"));
});
