import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "./desktop-fixture.mjs";
import {
  standardExtensionFixture,
  installStandardExtensions,
  readExtensionTrace,
} from "./standard-extension-fixture.mjs";

const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
const has = (rows, type) => rows.some((row) => row.type === type);

async function nativeControl(f) {
  const cwd = join(f.root, "native-project"),
    agentDir = join(f.root, "native-agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    await readFile(join(f.agentDir, "settings.json")),
  );
  // 每个对照也亲自走原生安装；不复用 Desktop 的已加载工厂或 runner。
  const settings = JSON.parse(
    await readFile(join(agentDir, "settings.json"), "utf8"),
  );
  delete settings.packages;
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
  await writeFile(
    join(agentDir, "models.json"),
    await readFile(join(f.agentDir, "models.json")),
  );
  const { sdk } = await installStandardExtensions({
    cwd,
    agentDir,
    root: join(f.root, "native-packages"),
  });
  const runtime = await sdk.createAgentSessionRuntime(
    async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await sdk.createAgentSessionServices({ cwd, agentDir });
      return {
        ...(await sdk.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    },
    { cwd, agentDir, sessionManager: sdk.SessionManager.inMemory(cwd) },
  );
  const ui = [];
  try {
    await runtime.session.bindExtensions({
      mode: "rpc",
      uiContext: {
        setStatus: (...args) => ui.push({ type: "status", args }),
        setWidget: (...args) => ui.push({ type: "widget", args }),
        notify: (...args) => ui.push({ type: "notify", args }),
        select: async () => "代码",
        confirm: async () => true,
        input: async () => "NATIVE_USER_NOTE",
        editor: async () => "EDITED_NATIVE_DOCUMENT",
      },
    });
    return { cwd, session: runtime.session, ui, runtime };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("两个普通扩展经真实 Pi 安装、发现、工具／命令与重载进入 Desktop Host", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  const initial = await f.api("state");
  for (const name of ["compat_notes", "compat_check"])
    assert(initial.tools.includes(name));
  const commands = (await f.api("commands")).rows;
  for (const name of ["notes-status", "review-flow"])
    assert(
      commands.some((row) => row.name === name && row.source === "extension"),
    );
  assert(initial.statuses.includes("笔记工具就绪"));
  t.diagnostic(
    `阶段 06 普通 widget 是否进入聊天投影：${JSON.stringify(JSON.stringify(initial.messages).includes("NOTES_WIDGET_READY"))}`,
  );
  assert.equal(
    (await readExtensionTrace(f.cwd)).filter(
      (row) => row.type === "session_start",
    ).length,
    1,
  );
  assert.equal(
    (await readExtensionTrace(f.cwd, "review")).filter(
      (row) => row.type === "session_start",
    ).length,
    1,
  );

  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_STREAM" });
  let state = await f.settled();
  assert(
    state.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.text ===
          "NOTES_RESULT:fixture-note:REVIEWED_INPUT:REVIEWED_RESULT",
    ),
  );
  const notes = await readExtensionTrace(f.cwd);
  assert.equal(notes.filter((row) => row.type === "execute").length, 1);
  assert(
    has(notes, "before_agent_start") &&
      has(notes, "agent_start") &&
      has(notes, "agent_end") &&
      has(notes, "agent_settled"),
  );
  const review = await readExtensionTrace(f.cwd, "review");
  assert(has(review, "tool_call") && has(review, "tool_result"));
  // 诊断只记录当时的差异，不把已知缺口固定为产品应有行为。
  t.diagnostic(
    `阶段 06 Desktop 生命周期观察：${JSON.stringify({ input: has(notes, "input"), messageUpdates: has(notes, "message_update"), toolStart: has(notes, "tool_execution_start"), toolUpdates: has(notes, "tool_execution_update"), turnEntryIds: notes.filter((row) => row.type === "turn_end").every((row) => !!row.messageEntryId), beforeSettle: has(notes, "agent_before_settle"), systemContext: notes.filter((row) => row.type === "context_with_system").every((row) => row.leadingSystem) })}`,
  );

  const count = f.requests.length;
  await f.api("prompt", { sessionId: f.id, message: "/notes-status" });
  state = await until(
    () => f.api("state"),
    (value) =>
      value.messages.some(
        (message) => message.text === "NOTES_COMMAND_RESULT:1",
      ),
  );
  assert.equal(f.requests.length, count, "标准命令不偷开模型循环");
  assert(
    state.messages.some(
      (message) =>
        message.role === "custom" && message.text === "NOTES_COMMAND_RESULT:1",
    ),
  );
  await f.api("prompt", { sessionId: f.id, message: "RUN_REVIEW_CHECK" });
  state = await f.settled();
  assert(
    state.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.text === "CHECK_RESULT:fixture-target",
    ),
  );
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_BLOCK" });
  state = await f.settled();
  assert(
    state.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.isError &&
        message.text.includes("REVIEW_BLOCKED_THE_NOTE"),
    ),
  );
  assert.equal(
    (await readExtensionTrace(f.cwd)).filter((row) => row.type === "execute")
      .length,
    1,
    "原生阻止决策在工具副作用前生效",
  );

  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  const reloaded = await readExtensionTrace(f.cwd);
  const starts = reloaded.filter((row) => row.type === "session_start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].reason, "reload");
  assert.notEqual(starts[0].instance, starts[1].instance);
  assert.equal(starts[1].calls, 1, "原生 appendEntry 状态随 reload 保留");
  assert(
    reloaded.findIndex(
      (row) => row.type === "session_shutdown" && row.reason === "reload",
    ) < reloaded.findIndex((row) => row === starts[1]),
  );
  assert.equal(
    (await f.api("commands")).rows.filter((row) => row.name === "notes-status")
      .length,
    1,
  );
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_PING" });
  await f.settled();
  const fresh = (await readExtensionTrace(f.cwd)).findLast(
    (row) => row.type === "execute",
  );
  assert.equal(fresh.calls, 2);
  assert.equal(fresh.pings, 1);
  t.diagnostic(
    `阶段 06 reload 上下文观察：${JSON.stringify({ toolSignal: fresh.toolSignal, contextSignal: fresh.contextSignal })}`,
  );

  const settings = f.sdk.SettingsManager.create(f.cwd, f.agentDir, {
    projectTrusted: true,
  });
  const packages = settings.getPackages();
  settings.setPackages([{ source: packages[0], extensions: [] }, packages[1]]);
  await settings.flush();
  assert.deepEqual(settings.drainErrors(), []);
  const startsBeforeDisable = (await readExtensionTrace(f.cwd)).filter(
    (row) => row.type === "session_start",
  ).length;
  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  assert.equal(
    (await readExtensionTrace(f.cwd)).filter(
      (row) => row.type === "session_start",
    ).length,
    startsBeforeDisable,
    "Pi 的资源禁用过滤阻止工厂重新接入",
  );
  assert(
    !(await f.api("commands")).rows.some((row) => row.name === "notes-status"),
  );
  assert(
    (await f.api("commands")).rows.some((row) => row.name === "review-flow"),
  );
  const checksBefore = (await f.api("state")).messages.filter(
    (message) =>
      message.role === "toolResult" && message.toolName === "compat_check",
  ).length;
  await f.api("prompt", { sessionId: f.id, message: "RUN_REVIEW_CHECK" });
  await until(
    () => f.api("state"),
    (value) =>
      value.idle &&
      value.messages.filter(
        (message) =>
          message.role === "toolResult" && message.toolName === "compat_check",
      ).length ===
        checksBefore + 1,
  );
  settings.setPackages(packages);
  await settings.flush();
  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  assert.equal(
    (await readExtensionTrace(f.cwd)).findLast(
      (row) => row.type === "session_start",
    ).calls,
    2,
  );
  assert.equal(
    (await f.api("commands")).rows.filter((row) => row.name === "notes-status")
      .length,
    1,
  );
  settings.setPackages([packages[0], { source: packages[1], extensions: [] }]);
  await settings.flush();
  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  assert(
    !(await f.api("commands")).rows.some((row) => row.name === "review-flow"),
  );
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_PING" });
  state = await f.settled();
  assert(
    state.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.text === "NOTES_RESULT:fixture-note",
    ),
    "笔记包也不依赖复核包；工具未经过已禁用的 handler",
  );
});

test("相同扩展源码在内嵌 Pi 1.0.0 中给出决策、边界与标准 UI 的原生对照", async (t) => {
  const f = await standardExtensionFixture();
  let native;
  t.after(async () => {
    await native?.runtime.dispose();
    await f.close();
  });
  native = await nativeControl(f);
  const { session, cwd } = native;
  assert(session.getAllTools().some((tool) => tool.name === "compat_notes"));
  assert(session.extensionRunner.getCommand("review-flow"));
  await session.prompt("RUN_NOTES_STREAM");
  let rows = await readExtensionTrace(cwd);
  for (const type of [
    "input",
    "before_agent_start",
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "turn_end",
    "agent_end",
    "agent_before_settle",
    "agent_settled",
  ])
    assert(has(rows, type), type);
  for (const row of rows.filter((row) => row.type === "turn_end")) {
    assert.equal(typeof row.turnIndex, "number");
    assert.equal(typeof row.messageEntryId, "string");
    assert(Array.isArray(row.toolResultEntryIds));
    assert(row.boundary);
  }
  assert(
    rows
      .filter((row) => row.type === "context_with_system")
      .every((row) => row.leadingSystem),
  );
  assert(
    session.agent.state.messages.some(
      (message) =>
        message.role === "toolResult" &&
        text(message) ===
          "NOTES_RESULT:fixture-note:REVIEWED_INPUT:REVIEWED_RESULT",
    ),
  );
  await session.prompt("INPUT_TRANSFORM_PROBE");
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "user" && text(message) === "INPUT_REWRITTEN",
      ),
  );
  const count = f.requests.length;
  await session.prompt("INPUT_HANDLED_PROBE");
  assert.equal(f.requests.length, count);
  assert(
    session.agent.state.messages.some(
      (message) =>
        message.role === "custom" && text(message) === "INPUT_WAS_HANDLED",
    ),
  );
  await session.prompt("PROMPT_OVERRIDE_PROBE");
  assert.equal(
    f.requests.at(-1).messages[0].content,
    "FORCED_NATIVE_SYSTEM_PROMPT",
  );
  await session.prompt("MESSAGE_REPLACEMENT_PROBE");
  assert.equal(
    text(session.agent.state.messages.at(-1)),
    "REPLACED_NATIVE_ANSWER",
  );
  for (const [prompt, marker] of [
    ["TURN_BOUNDARY_PROBE", "TURN_BOUNDARY_CONTEXT"],
    ["SETTLE_BOUNDARY_PROBE", "SETTLE_BOUNDARY_CONTEXT"],
  ]) {
    const before = f.requests.length;
    await session.prompt(prompt);
    assert.equal(f.requests.length, before + 2, prompt);
    assert(
      session.agent.state.messages.some(
        (message) => message.role === "custom" && text(message) === marker,
      ),
    );
  }
  await session.prompt("/review-flow");
  assert(
    session.agent.state.messages.some(
      (message) =>
        message.role === "custom" &&
        text(message) === "REVIEW_RESULT:EDITED_NATIVE_DOCUMENT",
    ),
  );
  assert(
    native.ui.some(
      (event) =>
        event.type === "notify" && event.args[0] === "REVIEW_NOTICE_COMPLETE",
    ),
  );
  assert(
    native.ui.some(
      (event) =>
        event.type === "widget" &&
        event.args[0] === "notes-summary" &&
        event.args[1].includes("NOTES_WIDGET_READY"),
    ),
  );
  const first = rows.find((row) => row.type === "session_start");
  await session.reload();
  rows = await readExtensionTrace(cwd);
  const last = rows.findLast((row) => row.type === "session_start");
  assert.notEqual(first.instance, last.instance);
  assert.equal(last.reason, "reload");
  assert.equal(last.calls, 1);
  await native.runtime.dispose();
  native = undefined;
  assert.equal((await readExtensionTrace(cwd)).at(-1).type, "session_shutdown");
  assert.equal((await readExtensionTrace(cwd)).at(-1).reason, "quit");
});
