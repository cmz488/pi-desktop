import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { eventSourceAt, perchoConsumers } from "./percho-fixture.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";
import { createSessionTransport } from "../src/ui-next/session-transport.mjs";
import { createSubscriptions } from "../src/ui-next/subscriptions.mjs";
import { toTranscript } from "../src/ui-next/session-projection.mjs";

function transport(f) {
  const io = {
    get: (path) => f.call(path),
    post: (path, body) => f.call(path, body),
  };
  const sessions = createSessionTransport(io);
  return { sessions, handlers: createHttpHandlers({ ...io, sessions }) };
}

test("默认首启在后台 worker 就绪后提供模型目录，不把启动中的进程当作失败", async (t) => {
  const f = await desktopFixture({ defaultConversation: true });
  t.after(() => f.close());
  const { handlers: h } = transport(f);
  const models = await h["models:list"]();
  assert(
    models.some((row) => row.provider === "desktop-fixture" && row.authed),
  );
  const loaded = await h["session:getLoaded"]();
  assert.equal(loaded.length, 1);
});

test("默认多进程 Host：建会话、文件身份重开、历史消费与目标隔离", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const { handlers: h } = transport(f);
  const a = await h["session:create"]({ options: { cwd: f.cwd } });
  const b = await h["session:create"]({ options: { cwd: f.other } });
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.cwd, f.cwd);
  assert.equal(b.cwd, f.other);
  assert.ok(Number.isFinite(a.createdAt) && a.createdAt > 0);
  const catalog = await h["session:listAll"]();
  const consumer = await perchoConsumers();
  assert(
    consumer.parseEnvironmentUiState({
      version: 1,
      projects: [],
      dailyDirs: [],
      pinnedSessions: [],
      pinnedProjects: [],
      expandedGroups: [],
      expandedGroupsTouched: false,
      lastCwd: null,
      workspace: {
        members: [{ file: a.sessionFile, sessionId: a.sessionId }],
        activeFile: a.sessionFile,
        recentFile: a.sessionFile,
      },
      catalog,
    }),
    "目录可持久化和恢复，ISO 时间不能变成 NaN",
  );
  const models = await h["models:list"]();
  assert.equal(models[0].provider, "desktop-fixture");
  assert.equal(models[0].authed, true);
  assert.equal(
    (await h["session:open"]({ filePath: a.sessionFile })).sessionId,
    a.sessionId,
  );
  const loaded = await h["session:getLoaded"]();
  assert(loaded.some((row) => row.meta.sessionId === b.sessionId));
  const pending = await h["session:getPendingInteractions"]();
  assert.deepEqual(pending, {
    revision: 0,
    permissions: [],
    dialogs: [],
    trust: [],
  });
  await h["session:prompt"]({ sessionId: b.sessionId, text: "ONLY_B" });
  const rows = await until(
    () => h["session:getMessages"]({ sessionId: b.sessionId }),
    (rows) =>
      rows.some(
        (row) => row.role === "assistant" && row.text.includes("ONLY_B"),
      ),
  );
  assert(
    !(await h["session:getMessages"]({ sessionId: a.sessionId })).some((row) =>
      row.text.includes("ONLY_B"),
    ),
  );
  const messages = consumer.messagesToUIMessages(rows);
  assert.doesNotThrow(() =>
    consumer.buildChatRows(
      { ...consumer.emptyTranscript(), messages },
      b.sessionId,
    ),
  );
  await h["session:setName"]({
    sessionId: b.sessionId,
    name: "Only B renamed",
  });
  assert.equal(
    (await h["session:listAll"]()).find((row) => row.sessionId === b.sessionId)
      .name,
    "Only B renamed",
  );
  assert.deepEqual(await h["session:close"]({ sessionId: a.sessionId }), {
    closed: true,
  });
  assert.equal(
    (await f.call("/api/workspace")).agents.find(
      (row) => row.id === a.sessionId,
    ).status,
    "running",
    "关 tab 不停止独立 worker",
  );
  await h["session:delete"]({ sessionId: b.sessionId });
  const final = await f.call("/api/workspace");
  assert.equal(
    final.agents.find((row) => row.id === b.sessionId).archived,
    true,
  );
  assert.equal(
    final.agents.find((row) => row.id === a.sessionId).status,
    "running",
  );
});

test("真实 SSE 转换：回复、通知、预填与一次性对话框均到达所属会话", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const extension = join(f.cwd, "ui-fixture.mjs");
  await writeFile(
    extension,
    `export default function(pi) {
    pi.registerCommand("editor-probe", {handler: async (_args, ctx) => {
      ctx.ui.notify("EDITOR=" + ctx.ui.getEditorText());
      ctx.ui.setEditorText("prefilled");
    }});
    pi.registerCommand("dialog-probe", {handler: async (_args, ctx) => {
      const answer = await ctx.ui.input("ASK_INPUT"); ctx.ui.notify("ANSWER=" + answer);
    }});
  }`,
  );
  const settingsPath = join(f.agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(
    settingsPath,
    JSON.stringify({ ...settings, extensions: [extension] }),
  );
  const { sessions, handlers: h } = transport(f);
  const a = await h["session:create"]({ options: { cwd: f.cwd } });
  const b = await h["session:create"]({ options: { cwd: f.other } });
  const events = [],
    notifications = [],
    editor = [],
    dialogs = [],
    resolved = [],
    errors = [];
  const subscribe = createSubscriptions({
    sessions,
    EventSource: eventSourceAt(f.app.url),
    onError: (error) => errors.push(error),
  });
  const offs = [
    subscribe("onEvent", "", (event) => events.push(event)),
    subscribe("onExtensionNotify", "", (event) => notifications.push(event)),
    subscribe("onExtensionEditorText", "", (event) => editor.push(event)),
    subscribe("onExtensionDialogRequest", "", (event) => dialogs.push(event)),
    subscribe("onExtensionDialogResolved", "", (event) => resolved.push(event)),
  ];
  t.after(() => offs.forEach((off) => off()));
  await until(
    async () => events,
    (rows) =>
      rows.some((row) => row.sessionId === a.sessionId) &&
      rows.some((row) => row.sessionId === b.sessionId),
  );
  await h["session:prompt"]({ sessionId: b.sessionId, text: "SSE_ANSWER" });
  const event = await until(
    async () => events.at(-1),
    (event) =>
      event?.sessionId === b.sessionId &&
      event.event.transcript.messages.some(
        (row) => row.kind === "assistant" && row.text.includes("SSE_ANSWER"),
      ),
  );
  const consumer = await perchoConsumers();
  assert.doesNotThrow(() =>
    consumer.buildChatRows(
      consumer.reduceEvent(consumer.emptyTranscript(), event.event),
      b.sessionId,
    ),
  );
  assert.equal(event.event.usage.contextWindow, 8192);
  await h["session:setName"]({ sessionId: b.sessionId, name: "SSE_NAME" });
  await until(
    async () => events,
    (rows) =>
      rows.some(
        (row) => row.sessionId === b.sessionId && row.event.name === "SSE_NAME",
      ),
  );
  const mirror = sessions.mirrorComposer(b.sessionId, "draft-B");
  await h["session:prompt"]({ sessionId: b.sessionId, text: "/editor-probe" });
  await mirror;
  await until(
    async () => notifications,
    (rows) =>
      rows.some(
        (row) =>
          row.sessionId === b.sessionId && row.message === "EDITOR=draft-B",
      ),
  );
  await until(
    async () => editor,
    (rows) =>
      rows.some(
        (row) => row.sessionId === b.sessionId && row.text === "prefilled",
      ),
  );
  const prompting = h["session:prompt"]({
    sessionId: b.sessionId,
    text: "/dialog-probe",
  });
  const request = await until(
    async () => dialogs.at(-1),
    (row) => row?.sessionId === b.sessionId && row.title === "ASK_INPUT",
  );
  await h["extension-dialog:respond"]({
    requestId: request.id,
    answer: { value: "USER_ANSWER" },
  });
  await prompting;
  await until(
    async () => notifications,
    (rows) =>
      rows.some(
        (row) =>
          row.sessionId === b.sessionId && row.message === "ANSWER=USER_ANSWER",
      ),
  );
  await until(
    async () => resolved,
    (rows) => rows.some((row) => row.requestId === request.id),
  );
  assert.deepEqual(errors, []);
});

test("UI 局部更新及并发保存跨 Host 重开保持完整", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  let { handlers: h } = transport(f);
  await h["uiState:save"]({
    state: { theme: "dark", sessionWorkspace: { activeFile: "a" } },
  });
  await Promise.all(
    Array.from({ length: 8 }, (_, n) =>
      h["uiState:save"]({ state: { [`field${n}`]: n } }),
    ),
  );
  await h["uiState:save"]({ state: { lastUsedThinkingLevel: "high" } });
  await h["environmentUi:save"]({ state: { environments: [] } });
  await f.reopen();
  h = transport(f).handlers;
  const state = await h["uiState:load"]();
  assert.equal(state.theme, "dark");
  assert.equal(state.lastUsedThinkingLevel, "high");
  for (let n = 0; n < 8; n++) assert.equal(state[`field${n}`], n);
  assert.deepEqual(state.sessionWorkspace, { activeFile: "a" });
  assert.deepEqual(await h["environmentUi:load"](), { environments: [] });
});

test("手机投影可被实际 Percho 行构建器和快照消费者使用", async () => {
  const consumer = await perchoConsumers();
  const transcript = toTranscript([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "toolCall", id: "c", name: "bash", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "c",
      content: [{ type: "text", text: "stdout" }],
    },
  ]);
  assert.equal(transcript.messages[0].images.length, 0);
  assert.equal(transcript.messages[1].tools[0].output, "stdout");
  assert.doesNotThrow(() => consumer.buildChatRows(transcript, "1"));
  const snap = {
    list: [],
    views: [],
    transcripts: [{ sessionId: "1", state: transcript, truncated: false }],
    snapshotSeq: 1,
    remoteControl: false,
  };
  const state = consumer.applyFrame(consumer.initialLanState, {
    event: "snapshot",
    data: snap,
  });
  assert.deepEqual(state.transcripts["1"], transcript);
  const streaming = toTranscript([], { streaming: { text: "live" } });
  assert.doesNotThrow(() => consumer.buildChatRows(streaming, "1"));
});
