import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTuiHost } from "../src/tui/tui-host.ts";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-tui-host-"));
  const host = getTuiHost(dir);
  const ctx = { isIdle: () => true };
  const pi = {
    sendUserMessage(message) {
      queueMicrotask(() => {
        void host.handle(message.split(" ").at(-1), ctx, pi);
      });
    },
  };
  host.bind(ctx, pi, () => ({
    idle: true,
    sessionId: "first",
    models: [],
    messages: [],
  }));
  t.after(async () => {
    await host.quit(dir);
    await rm(dir, { recursive: true, force: true });
  });
  return { host, dir, ctx, pi };
}

test("one process-owned transport survives extension factory replacement and rejects writes during handoff", async (t) => {
  const { host, dir } = await fixture(t);
  const url = new URL(
    await host.start({
      port: 0,
      host: "127.0.0.1",
      agentDir: dir,
      snapshot: () => host.snapshot(),
    }),
  );
  const state = () =>
    fetch(url.origin + "/api/state").then((response) => response.json());
  const first = await state();
  host.suspend();
  assert.equal((await state()).replacing, true);
  await assert.rejects(
    host.request(async () => {}),
    (error) => error.status === 409,
  );
  assert.equal(getTuiHost(dir), host);
  host.bind({ isIdle: () => true }, {}, () => ({
    idle: true,
    sessionId: "second",
    models: [],
    messages: [],
  }));
  host.changed();
  const second = await state();
  assert.equal(second.backend.id, first.backend.id);
  assert.equal(second.backend.pid, process.pid);
  assert.equal(second.epoch, first.epoch);
  assert.equal(second.sessionId, "second");
  assert.equal(second.replacing, false);
  await host.quit(dir);
  await assert.rejects(state());
});

test("a reloaded factory can wait for native startup UI longer than the orphan cleanup timeout", async (t) => {
  const { host, dir, ctx, pi } = await fixture(t);
  const origin = new URL(
    await host.start({
      port: 0,
      host: "127.0.0.1",
      agentDir: dir,
      snapshot: () => host.snapshot(),
    }),
  ).origin;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  host.suspend();
  getTuiHost(dir); // Factory loaded, but session_start is waiting for a human.
  t.mock.timers.tick(31_000);
  t.mock.timers.reset();
  assert.equal(host.snapshot().replacing, true);
  assert.equal((await fetch(origin + "/api/state")).status, 200);
  host.bind(ctx, pi, () => ({
    idle: true,
    sessionId: "after-dialog",
    models: [],
    messages: [],
  }));
  assert.equal(host.snapshot().sessionId, "after-dialog");
});

test("unexposed native changes trigger SSE refreshes only while a frontend is connected", async (t) => {
  const { host, dir, ctx, pi } = await fixture(t);
  let leaf = 0,
    checks = 0;
  host.bind(
    ctx,
    pi,
    () => ({
      idle: true,
      sessionId: "first",
      models: [],
      messages: [],
      hasPendingMessages: leaf > 0,
    }),
    () => {
      checks++;
      return String(leaf);
    },
  );
  const origin = new URL(
    await host.start({
      port: 0,
      host: "127.0.0.1",
      agentDir: dir,
      snapshot: () => host.snapshot(),
    }),
  ).origin;
  const state = () =>
    fetch(origin + "/api/state").then((response) => response.json());
  const initial = await state();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    `${origin}/api/events?epoch=${initial.epoch}&after=${initial.seq}`,
    { signal: controller.signal },
  );
  await response.body.getReader().read();
  leaf = 1;
  let updated;
  for (let i = 0; i < 50; i++) {
    updated = await state();
    if (updated.seq > initial.seq) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(updated.seq > initial.seq);
  assert.equal(updated.hasPendingMessages, true);
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const previous = checks;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(checks, previous, "No frontend means no native-state polling");
});

test("native command gateway uses a fresh context and serializes exclusive frontend changes", async (t) => {
  const { host, ctx, pi } = await fixture(t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = host.request(async (current, api) => {
    assert.equal(current, ctx);
    assert.equal(api, pi);
    await held;
    return "done";
  });
  await assert.rejects(
    host.request(async () => {}),
    (error) => error.status === 409,
  );
  assert.equal(host.snapshot().idle, false);
  release();
  assert.equal(await first, "done");
  assert.equal(host.snapshot().idle, true);
  ctx.isIdle = () => false;
  await assert.rejects(
    host.request(async () => {}),
    (error) => error.status === 409,
  );
  assert.equal(
    await host.request(async () => "queued", { exclusive: false }),
    "queued",
  );
  await assert.rejects(
    host.handle("expired", ctx, pi),
    (error) => error.status === 404,
  );
});
