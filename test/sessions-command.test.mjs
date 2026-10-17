import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSessionsCommand,
  resolveSessionId,
} from "../src/tui/sessions-command.mjs";
import { SessionHost, getSessionHost } from "../src/tui/session-manager.mjs";
import sessionsExtension, { SessionsView } from "../src/tui/sessions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInteractionStore } from "../src/agent/interaction-store.mjs";
import { until } from "./concurrent-fixture.mjs";

const rendered = (view) =>
  view
    .render(110)
    .join("\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const aid = "aaaaaaaa-1111-2222-3333-444444444444";
const bid = "bbbbbbbb-1111-2222-3333-444444444444";
test("sessions grammar, ID shorthand, prefix ambiguity and invalid arguments", () => {
  for (const [args, result] of [
    ["", { action: "show" }],
    [" new ", { action: "new" }],
    ["list", { action: "list" }],
    ["help", { action: "help" }],
    ["use aaaaaaaa", { action: "use", id: "aaaaaaaa" }],
    ["aaaaaaaa", { action: "use", id: "aaaaaaaa" }],
    ["stop", { action: "stop", id: undefined }],
    ["stop bbbbbbbb", { action: "stop", id: "bbbbbbbb" }],
  ])
    assert.deepEqual(parseSessionsCommand(args), result);
  for (const args of [
    null,
    "new more",
    "use",
    "use a b",
    "stop a b",
    "help more",
  ])
    assert.throws(
      () => parseSessionsCommand(args),
      (error) => error.status === 422,
    );
  const rows = [{ id: aid }, { id: bid }];
  assert.equal(resolveSessionId(rows, "aaaaaaaa"), aid);
  assert.equal(resolveSessionId(rows, bid), bid);
  assert.throws(
    () => resolveSessionId(rows, "aaaa"),
    (error) => error.status === 422,
  );
  assert.throws(
    () => resolveSessionId(rows, "cccccccc"),
    (error) => error.status === 404,
  );
  assert.throws(
    () =>
      resolveSessionId(
        [...rows, { id: aid.replace("1111", "5555") }],
        "aaaaaaaa",
      ),
    (error) => error.status === 409,
  );
});

function fixture(t) {
  const manager = new SessionHost();
  const stops = [];
  const options = (id) => ({
    snapshot: () => ({
      sessionId: id,
      name: id === aid ? "A" : "B",
      idle: true,
      messages: [],
      stats: { totalMessages: 0 },
    }),
    interactions: createInteractionStore(),
    abort: async () => {
      stops.push(id);
    },
    prompt: async () => {},
  });
  manager.transport(options(aid), { native: true });
  manager.createSlot = async ({ bridgeFactory }) => {
    bridgeFactory(options(bid));
    return { stop: async () => {} };
  };
  const tui = { terminal: { rows: 24 }, requestRender: () => {} };
  const theme = { fg: (_color, text) => text };
  const makeView = () => new SessionsView(tui, theme, manager, () => {});
  t.after(() => manager.dispose());
  return { manager, stops, makeView };
}

test("TUI switches drafts immediately, preserves them on reopen and displays ID errors", async (t) => {
  const f = fixture(t);
  let view = f.makeView();
  t.after(() => view.dispose());
  view.handleInput("草稿-A");
  await f.manager.create();
  view.handleInput("草稿-B");
  f.manager.focus(aid);
  assert(rendered(view).includes("草稿-A"));
  f.manager.focus(bid);
  assert(rendered(view).includes("草稿-B"));
  view.close();
  view.dispose();
  view = f.makeView();
  assert(rendered(view).includes("草稿-B"));
  view.handleInput("\x05");
  view.handleInput("\x15");
  view.handleInput("/use aaaa");
  view.handleInput("\r");
  await until(() => view.render(110).join("\n").includes("至少 8 位"));
  assert.equal(f.manager.focusId, bid);
});

test("Ctrl+N never replies to secret interaction; Ctrl+C cancels and stops only target", async (t) => {
  const f = fixture(t);
  const view = f.makeView();
  t.after(() => view.dispose());
  const store = f.manager.active.options.interactions;
  const jobId = store.start("fixture-secret", async (ui) => {
    try {
      return await ui.prompt({
        type: "text",
        message: "输入测试凭据",
        secret: true,
      });
    } catch {
      return undefined;
    }
  });
  await until(() => store.list().find((row) => row.id === jobId)?.prompt);
  f.manager.changed();
  view.handleInput("\x1b[200~secret-fixture-only\x1b[201~");
  view.handleInput("\x1b[200~!\x1b[201~");
  assert(!rendered(view).includes("secret-fixture-only"));
  view.handleInput("\x0e");
  await until(() => f.manager.focusId === bid);
  assert.equal(store.list().find((row) => row.id === jobId).status, "running");
  assert(store.list().find((row) => row.id === jobId).prompt);
  assert(
    !JSON.stringify([...f.manager.tuiDrafts]).includes("secret-fixture-only"),
  );
  view.handleInput("\x1f");
  assert(
    !rendered(view).includes("secret-fixture-only"),
    "undo in B must not recover A's secret input",
  );
  f.manager.focus(aid);
  view.handleInput("\x03");
  await until(() => f.stops.length === 1);
  assert.deepEqual(f.stops, [aid]);
  assert.equal(f.manager.focusId, aid);
  await until(
    () => store.list().find((row) => row.id === jobId).status !== "running",
  );
});

test("reloading onto legacy process state warns instead of replacing live slots", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-legacy-sessions-"));
  const manager = getSessionHost(dir);
  const notices = [];
  const handlers = new Map();
  let command;
  let starts = 0;
  let aborts = 0;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (_name, value) => {
      command = value;
    },
  };
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    sessionsExtension(pi);
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
  }
  const drafts = manager.tuiDrafts;
  t.after(async () => {
    delete manager.command;
    manager.tuiDrafts = drafts;
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  manager.transport(
    {
      snapshot: () => ({
        sessionId: aid,
        name: "A",
        idle: false,
        messages: [],
      }),
      abort: async () => {
        aborts++;
      },
    },
    { native: true },
  );
  manager.command = undefined;
  delete manager.tuiDrafts;
  manager.startNative = async () => {
    starts++;
    return "http://127.0.0.1/";
  };
  const noop = () => {};
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: dir,
    ui: {
      notify: (text) => notices.push(text),
      select: noop,
      confirm: noop,
      input: noop,
      editor: noop,
      custom: noop,
    },
  };
  handlers.get("session_start")({}, ctx);
  await command.handler("new", ctx);
  assert(notices.some((text) => text.includes("旧版会话管理器")));
  assert.equal(starts, 0);
  assert.equal(aborts, 0);
  assert.equal(manager.slots.size, 1);
  await command.handler("help", ctx);
  assert(notices.some((text) => text.includes("/sessions stop")));
  handlers.get("session_shutdown")({ reason: "quit" });
});
