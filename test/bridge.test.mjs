import { readUntil } from "./sse-reader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeskBridge } from "../src/server/bridge.mjs";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-desk-bridge-"));
  await mkdir(join(dir, "extensions", "pi-rtk-optimizer"), { recursive: true });
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({
      packages: ["npm:pi-rtk-optimizer"],
      someOtherSetting: true,
    }),
  );
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        demo: {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          apiKey: "fixture-secret",
          headers: { Authorization: "fixture-header" },
          models: [{ id: "model" }],
        },
      },
    }),
  );
  await writeFile(
    join(dir, "extensions", "pi-rtk-optimizer", "config.json"),
    JSON.stringify({
      guardWhenRtkMissing: true,
      showRewriteNotifications: true,
      outputCompaction: { untouched: true },
    }),
  );
  let prompts = [],
    idle = true;
  const bridge = createDeskBridge({
    agentDir: dir,
    port: 0,
    host: "127.0.0.1",
    snapshot: () => ({
      models: [{ provider: "demo", id: "model", name: "Model" }],
      idle,
      commands: options.btw ? [{ name: "btw", source: "extension" }] : [],
      messages: [],
    }),
    canWrite: () => idle,
    prompt: (...args) => prompts.push(args),
    abort: () => {},
    setModel: async () => {},
    refreshModels: async () => {},
    ...options,
    capabilities: {
      prompt: true,
      abort: true,
      model: true,
      canWrite: true,
      ...(options.capabilities ?? {}),
    },
  });
  const url = new URL(await bridge.start());
  const origin = url.origin;
  t.after(async () => {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const request = (path, input, extra = {}) =>
    fetch(
      `${origin}${path}`,
      input === undefined
        ? { headers: extra }
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: origin,
              ...extra,
            },
            body: JSON.stringify(input),
          },
    );
  const headers = {};
  return {
    bridge,
    request,
    headers,
    prompts,
    dir,
    setIdle: (value) => {
      idle = value;
    },
  };
}
test("pi-btw is exposed only when the extension command and Desktop adapter are available", async (t) => {
  const f = await fixture(t, {
    btw: async (input) => ({ action: input.action, threadId: "side-thread" }),
    capabilities: { btw: true },
  });
  const state = await f.request("/api/state");
  assert.equal((await state.json()).capabilities.btw, true);
  const response = await f.request("/api/btw", { action: "open" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    action: "open",
    threadId: "side-thread",
  });
});

test("direct access needs no login; config descriptors never expose saved provider keys or headers", async (t) => {
  const f = await fixture(t);
  const responseState = await f.request("/api/state");
  assert.equal(responseState.status, 200);
  const state = await responseState.json();
  assert(!("csrf" in state) && !("role" in state) && !("owner" in state));
  const response = await f.request("/api/providers", undefined, f.headers);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(!text.includes("fixture-secret"));
  assert(!text.includes("fixture-header"));
  const saved = await f.request(
    "/api/prompt",
    { message: "hello", mode: "follow_up" },
    f.headers,
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(f.prompts, [["hello", "follow_up"]]);
});
test("shared config writes need no device credentials; running-task and revision conflicts still apply", async (t) => {
  const f = await fixture(t);
  const inventory = await (
    await f.request("/api/plugins", undefined, f.headers)
  ).json();
  const patch = {
    id: inventory.rows[0].id,
    enabled: false,
    revision: inventory.revision,
  };
  f.setIdle(false);
  assert.equal((await f.request("/api/plugin", patch, f.headers)).status, 409);
  f.setIdle(true);
  assert.equal((await f.request("/api/plugin", patch, f.headers)).status, 200);
  const updated = await (
    await f.request("/api/plugins", undefined, f.headers)
  ).json();
  assert.equal(updated.rows[0].enabled, false);
  assert.equal(updated.pending, true);
  assert.equal((await f.request("/api/plugin", patch, f.headers)).status, 409);
});
test("plugin form adapter restricts paths and fields and preserves unedited fields", async (t) => {
  const f = await fixture(t);
  const document = await (
    await f.request("/api/plugin-config?id=package%3A0", undefined, f.headers)
  ).json();
  assert.equal(
    (
      await f.request(
        "/api/plugin-config",
        {
          id: "package:0",
          revision: document.revision,
          patch: { outputCompaction: {} },
        },
        f.headers,
      )
    ).status,
    422,
  );
  assert.equal(
    (
      await f.request(
        "/api/plugin-config",
        {
          id: "package:0",
          revision: document.revision,
          patch: { showRewriteNotifications: false },
        },
        f.headers,
      )
    ).status,
    200,
  );
  const { readDocument } = await import("../src/config/config-store.mjs");
  assert.deepEqual(
    (
      await readDocument(
        join(f.dir, "extensions", "pi-rtk-optimizer", "config.json"),
      )
    ).data.outputCompaction,
    { untouched: true },
  );
  assert.equal(
    (
      await f.request(
        "/api/plugin-config?id=../../settings.json",
        undefined,
        f.headers,
      )
    ).status,
    422,
  );
});
test("event replay catches missing history and preserves UTF-8 records", async (t) => {
  const f = await fixture(t);
  const state = await (
    await f.request("/api/state", undefined, f.headers)
  ).json();
  f.bridge.publish("text_delta", { delta: "手机继续\u2028行" });
  const controller = new AbortController();
  const url = new URL(await f.bridge.start());
  const response = await fetch(
    `${url.origin}/api/events?after=${state.seq}&epoch=${state.epoch}`,
    { headers: f.headers, signal: controller.signal },
  );
  const reader = response.body.getReader();
  const chunk = await readUntil(reader, "手机继续");
  assert(chunk.includes("手机继续"));
  controller.abort();
  const second = new AbortController();
  const resync = await fetch(
    `${url.origin}/api/events?after=999999&epoch=old`,
    { headers: f.headers, signal: second.signal },
  );
  assert(
    (await readUntil(resync.body.getReader(), "resync_required")).includes(
      "resync_required",
    ),
  );
  second.abort();
});
test("one cleartext listener serves localhost and LAN without access checks", async (t) => {
  const f = await fixture(t);
  const bridge = createDeskBridge({
    host: "0.0.0.0",
    port: 0,
    agentDir: f.dir,
    snapshot: () => ({ models: [], messages: [] }),
  });
  t.after(() => bridge.stop());
  const url = new URL(await bridge.start());
  assert.equal(url.hash, "");
  const response = await fetch(url.origin + "/api/state");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
});
test("occupied default port selects another port and instances keep independent state", async (t) => {
  const first = await fixture(t);
  const firstUrl = new URL(await first.bridge.start());
  const second = createDeskBridge({
    agentDir: first.dir,
    host: "127.0.0.1",
    port: Number(firstUrl.port),
    autoPort: true,
    snapshot: () => ({ models: [], messages: [], idle: true }),
    canWrite: () => true,
  });
  const secondUrl = new URL(await second.start());
  t.after(() => second.stop());
  assert.notEqual(secondUrl.port, firstUrl.port);
  assert.equal((await first.request("/api/state")).status, 200);
  assert.equal((await fetch(secondUrl.origin + "/api/state")).status, 200);
});

test("streaming replay bounds payload bytes and resynchronizes a client whose cursor was evicted", async (t) => {
  const f = await fixture(t);
  const state = await (
    await f.request("/api/state", undefined, f.headers)
  ).json();
  for (let i = 0; i < 160; i++)
    f.bridge.publish("assistant_update", { text: "x".repeat(60000) });
  const controller = new AbortController(),
    url = new URL(await f.bridge.start());
  const response = await fetch(
    `${url.origin}/api/events?after=${state.seq}&epoch=${state.epoch}`,
    { headers: f.headers, signal: controller.signal },
  );
  assert(
    (await readUntil(response.body.getReader(), "resync_required")).includes(
      "resync_required",
    ),
  );
  controller.abort();
});

test("model and thinking changes defer while running, while Pi settings remain saveable", async (t) => {
  let allowDeferred = true,
    model = "original",
    level = "high",
    queued = [];
  const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const f = await fixture(t, {
    snapshot: () => ({
      sessionId: "sol",
      model: { id: "gpt-6.1-sol" },
      thinkingLevels: levels,
      thinkingLevel: level,
      idle: false,
    }),
    canSetThinking: () => false,
    canDeferConfiguration: () => allowDeferred,
    setModel: async (_provider, value, { defer }) => {
      if (defer) queued.push({ model: value });
      else model = value;
    },
    setThinking: async (value, { defer }) => {
      if (defer) queued.push({ thinkingLevel: value });
      else level = value;
    },
    capabilities: {
      thinking: true,
      canSetThinking: true,
      canDeferConfiguration: true,
      settings: true,
      canSaveSettings: true,
      settingsChanged: true,
    },
    effectiveSettings: () => ({}),
    settingsChanged: () => {},
  });
  f.setIdle(false);
  const modelChange = await f.request("/api/model", {
    provider: "demo",
    id: "model",
  });
  assert.equal(modelChange.status, 200);
  assert.equal((await modelChange.json()).deferred, true);
  const thinkingChange = await f.request("/api/thinking", { level: "low" });
  assert.equal(thinkingChange.status, 200);
  assert.equal((await thinkingChange.json()).deferred, true);
  assert.equal(model, "original", "running requests retain their model");
  assert.equal(level, "high", "running requests retain their thinking level");
  assert.deepEqual(queued, [{ model: "model" }, { thinkingLevel: "low" }]);
  assert.equal(
    (await f.request("/api/thinking", { level: "off" })).status,
    422,
  );
  const settings = await (await f.request("/api/settings?scope=global")).json();
  assert.equal(
    (
      await f.request("/api/settings", {
        scope: "global",
        revision: settings.revision,
        patch: { defaultThinkingLevel: "low" },
      })
    ).status,
    200,
  );
  allowDeferred = false;
  assert.equal(
    (await f.request("/api/thinking", { level: "high" })).status,
    409,
  );
  const legacy = await fixture(t);
  legacy.setIdle(false);
  assert.equal(
    (await legacy.request("/api/thinking", { level: "low" })).status,
    409,
  );
});

test("Host capabilities, not optional option presence, drive feature advertisement", async (t) => {
  const plain = await fixture(t);
  const plainState = await (await plain.request("/api/state")).json();
  assert.equal(plainState.packageManagement, false);
  assert.equal(plainState.packageUpdates, false);
  assert.equal(plainState.capabilities.sessions, false);

  const capable = await fixture(t, {
    listSessions: async () => [],
    packageAction: async () => ({ ok: true }),
    packageUpdates: async () => ({ supported: true, rows: [] }),
    capabilities: {
      sessions: true,
      packageManagement: true,
      packageUpdates: true,
    },
  });
  const capableState = await (await capable.request("/api/state")).json();
  assert.equal(capableState.packageManagement, true);
  assert.equal(capableState.packageUpdates, true);
  assert.equal(capableState.capabilities.sessions, true);

  const callbackOnly = await fixture(t, {
    listSessions: async () => [],
    packageAction: async () => ({ ok: true }),
    packageUpdates: async () => ({ supported: true, rows: [] }),
  });
  const callbackOnlyState = await (
    await callbackOnly.request("/api/state")
  ).json();
  assert.equal(callbackOnlyState.packageManagement, false);
  assert.equal(callbackOnlyState.packageUpdates, false);
  assert.equal(callbackOnlyState.capabilities.sessions, false);
});

test("a file picker that outlives its Agent target is rejected by the request token", async (t) => {
  let dir;
  let session = "A";
  const f = await fixture(t, {
    snapshot: () => ({
      sessionId: session,
      cwd: dir,
      idle: true,
      messages: [],
    }),
    filePicker: {
      pickFiles: async () => {
        session = "B";
        return [join(dir, "context.txt")];
      },
    },
  });
  dir = f.dir;
  await writeFile(join(dir, "context.txt"), "context");
  const response = await f.request("/api/context/files", { sessionId: "A" });
  assert.equal(response.status, 409);
});

test("requestContext capability gates its callback even when the callback exists", async (t) => {
  let calls = 0;
  const off = await fixture(t, {
    requestContext: (request, response, run) => {
      calls++;
      return run();
    },
  });
  assert.equal((await off.request("/api/state")).status, 200);
  assert.equal(calls, 0);

  const on = await fixture(t, {
    requestContext: (request, response, run) => {
      calls++;
      return run();
    },
    capabilities: { requestContext: true },
  });
  assert.equal((await on.request("/api/state")).status, 200);
  assert.equal(calls, 1);
});

test("session and session-command capabilities gate their callbacks and responses", async (t) => {
  let listed = 0,
    commands = 0,
    created = 0,
    switched = 0;
  const f = await fixture(t, {
    listSessions: async () => {
      listed++;
      return [{ id: "A", name: "one", live: true }];
    },
    sessionCommand: async () => {
      commands++;
      return { text: "sessions output" };
    },
    newSession: async () => {
      created++;
      return { sessionId: "B" };
    },
    switchSession: async (id) => {
      switched++;
      return { sessionId: id };
    },
    canManageSessions: () => true,
    capabilities: {
      sessions: true,
      newSession: true,
      switchSession: true,
      sessionCommand: true,
      canManageSessions: true,
    },
  });
  const sessions = await (await f.request("/api/sessions")).json();
  assert.equal(sessions.supported, true);
  assert.deepEqual(sessions.rows, [{ id: "A", name: "one", live: true }]);
  assert.equal(listed, 1);
  assert.equal((await f.request("/api/new-session", {})).status, 200);
  assert.equal(created, 1);
  assert.equal(
    (await f.request("/api/switch-session", { id: "B" })).status,
    200,
  );
  assert.equal(switched, 1);
  const command = await f.request("/api/prompt", {
    message: "/sessions list",
  });
  assert.equal(command.status, 200);
  assert.equal((await command.json()).sessionCommand.text, "sessions output");
  assert.equal(commands, 1);

  const off = await fixture(t, {
    sessionCommand: async () => {
      commands++;
      return { text: "must not run" };
    },
  });
  const before = commands;
  const prompt = await off.request("/api/prompt", {
    message: "/sessions list",
  });
  assert.equal(prompt.status, 200);
  assert.equal(commands, before);
  assert.equal((await prompt.json()).sessionCommand, undefined);
});

test("effective settings are projected only when the settings capability is declared", async (t) => {
  const off = await fixture(t, {
    effectiveSettings: () => ({ theme: "dark" }),
  });
  assert.equal(
    (await (await off.request("/api/settings?scope=global")).json()).effective,
    null,
  );

  const on = await fixture(t, {
    effectiveSettings: () => ({ theme: "dark" }),
    capabilities: { settings: true },
  });
  assert.equal(
    (await (await on.request("/api/settings?scope=global")).json()).effective
      .theme,
    "dark",
  );
});
