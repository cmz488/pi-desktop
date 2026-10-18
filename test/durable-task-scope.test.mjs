import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  MemoryStorage,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { createBackgroundFixture } from "./background-fixture.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toolCall = (id, name) =>
  fauxAssistantMessage([{ type: "toolCall", id, name, arguments: {} }], {
    stopReason: "toolUse",
  });

async function fixture(t, { readOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-scope-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const models = createModels();
  const faux = fauxProvider({ tokensPerSecond: 10000 });
  models.setProvider(faux.provider);
  let releaseHold;
  const holdGate = new Promise((resolve) => (releaseHold = resolve));
  // 只派生临时 Durable 会话、使用本地 faux 响应，不启动 pi-subagents。
  const family = defineExtension({
    name: "task-scope-fixture",
    tools: [
      defineTool({
        name: "spawn_child",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async (_args, api, context) => {
          const id = await api.commit(async (tx) => {
            const row = await tx.createConversation({
              ownership: { kind: "task", taskId: api.taskId },
            });
            return row.id;
          }, context);
          const child = await api.conversation(id, context);
          const submission = await child.submit(
            {
              type: "input",
              content: "派生夹具工作",
              requestId: `scope-child:${api.taskId}`,
            },
            context,
          );
          const settled = await submission.wait(context);
          return { content: [{ type: "text", text: settled.status }] };
        },
      }),
      defineTool({
        name: "hold",
        parameters: Type.Object({}),
        execute: async () => {
          await holdGate;
          return { content: [{ type: "text", text: "已放行" }] };
        },
      }),
    ],
  });
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
    extensions: [family, createBackgroundFixture().extension],
    settings: { retry: { enabled: false } },
  });
  const ids = [];
  let app;
  t.after(async () => {
    releaseHold();
    try {
      for (const id of ids)
        await workspace.execute("cancel", { id, background: true });
    } finally {
      try {
        await app?.stop();
        await workspace.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
  for (const name of ["A", "B"])
    ids.push(
      (
        await workspace.execute("create", {
          cwd,
          name,
          model: { provider: faux.provider.id, modelId: faux.models[0].id },
        })
      ).id,
    );
  app = await startDurableDesk({
    workspace,
    port: 0,
    agentDir: join(root, "agent"),
    directory: join(root, "host"),
    resources: false,
    readOnly,
  });
  const origin = new URL(app.url).origin;
  const read = async (path, id) => {
    const response = await fetch(`${origin}${path}?id=${id}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (path, id, input, headers = {}) => {
    const response = await fetch(`${origin}${path}?id=${id}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({ id, sessionId: String(id), ...input }),
    });
    return { status: response.status, body: await response.json() };
  };
  const command = (id, input, headers) =>
    post("/api/command", id, input, headers);
  const waitFor = async (predicate, label) => {
    for (let index = 0; index < 400; index++) {
      const value = await predicate();
      if (value) return value;
      await sleep(20);
    }
    throw new Error(`夹具等待超时：${label}`);
  };
  const spawn = async (id, label, nested = false) => {
    const background = (suffix) =>
      toolCall(`${label}:${suffix}`, "background_work");
    faux.setResponses([
      ...(nested
        ? [
            toolCall(`${label}:child`, "spawn_child"),
            toolCall(`${label}:grandchild`, "spawn_child"),
            background("grandchild-background"),
            fauxAssistantMessage(`${label}:grandchild-done`),
            background("child-background"),
            fauxAssistantMessage(`${label}:child-done`),
          ]
        : []),
      background("root-background"),
      fauxAssistantMessage(`${label}:done`),
    ]);
    const response = await post("/api/prompt", id, { message: label });
    assert.equal(response.status, 200);
    await waitFor(async () => {
      const state = await read("/api/state", id);
      return (
        state.idle && state.messages.some((row) => row.text === `${label}:done`)
      );
    }, label);
  };
  const hold = async (id, { inChild = false } = {}) => {
    faux.setResponses([
      ...(inChild ? [toolCall(`hold-child:${id}`, "spawn_child")] : []),
      toolCall(`hold:${id}`, "hold"),
      fauxAssistantMessage("已完成挂起任务"),
      ...(inChild ? [fauxAssistantMessage("已完成父任务")] : []),
    ]);
    assert.equal(
      (await post("/api/prompt", id, { message: "挂起" })).status,
      200,
    );
    await waitFor(async () => {
      const graph = await read("/api/tasks", id);
      return inChild
        ? graph.tasks.some(
            (row) => row.kind === "pi.tool" && row.conversationId !== id,
          )
        : graph.tools.some((row) => row.name === "hold");
    }, "前台工具");
  };
  return {
    ids,
    workspace,
    app,
    read,
    command,
    spawn,
    waitFor,
    hold,
    releaseHold,
  };
}

test("任务读模型只返回所选会话及其 owned 后代，不包含另一个顶层会话", async (t) => {
  const {
    ids: [a, b],
    read,
    spawn,
  } = await fixture(t);
  await spawn(a, "A", true);
  await spawn(b, "B", true);
  const aGraph = await read("/api/tasks", a);
  const bGraph = await read("/api/tasks", b);
  assert.equal(aGraph.sessionId, String(a));
  assert.equal(aGraph.conversations.length, 2, "A 的子会话及孙会话均可见");
  assert.equal(bGraph.conversations.length, 2, "B 有独立的 owned 后代");
  const aIds = new Set([a, ...aGraph.conversations.map((row) => row.id)]);
  const bIds = new Set([b, ...bGraph.conversations.map((row) => row.id)]);
  assert.equal(aGraph.tasks.length, 3, "A 与两层后代各有一个真实后台任务");
  assert.equal(bGraph.tasks.length, 3);
  assert.ok(aGraph.tasks.every((row) => aIds.has(row.conversationId)));
  assert.ok(bGraph.tasks.every((row) => bIds.has(row.conversationId)));
  assert.ok(
    [...aIds].every((id) => !bIds.has(id)),
    "两个任务家族不可混在一起",
  );
  assert.ok(
    aGraph.tasks.every(
      (row) => row.background && row.kind === "fixture.anchor",
    ),
  );
});

test("指定任务取消校验会话归属，但允许管理自己的 owned 后代", async (t) => {
  const {
    ids: [a, b],
    read,
    command,
    spawn,
  } = await fixture(t);
  await spawn(a, "A", true);
  await spawn(b, "B", true);
  const aGraph = await read("/api/tasks", a);
  const bGraph = await read("/api/tasks", b);
  const foreign = bGraph.tasks.find((row) => row.conversationId === b);
  const denied = await command(a, { command: "cancel", taskId: foreign.id });
  assert.equal(denied.status, 404, "A 不能取消 B 的任务，也不能借错误泄露归属");
  assert.deepEqual(
    (await read("/api/tasks", b)).tasks.map((row) => row.id).sort(),
    bGraph.tasks.map((row) => row.id).sort(),
    "被拒绝的请求不改变 B 的任务",
  );
  const descendant = aGraph.tasks.find((row) => row.conversationId !== a);
  const cancelled = await command(a, {
    command: "cancel",
    taskId: descendant.id,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, true);
  assert.ok(
    !(await read("/api/tasks", a)).tasks.some(
      (row) => row.id === descendant.id,
    ),
  );
  for (const taskId of [-1, "1", 1.5]) {
    assert.equal((await command(a, { command: "cancel", taskId })).status, 422);
  }
  assert.equal(
    (await command(a, { command: "cancel", taskId: 999999 })).status,
    404,
  );
});

test("等待拒绝越界任务，并能等待 owned 后代的真实终态", async (t) => {
  const {
    ids: [a, b],
    read,
    command,
    spawn,
  } = await fixture(t);
  await spawn(a, "A", true);
  await spawn(b, "B");
  const own = (await read("/api/tasks", a)).tasks.find(
    (row) => row.conversationId !== a,
  );
  const foreign = (await read("/api/tasks", b)).tasks[0];
  const rejected = await Promise.race([
    command(a, { command: "wait", taskId: foreign.id }),
    sleep(2000).then(() => ({ status: "未拒绝越界等待" })),
  ]);
  assert.equal(rejected.status, 404);
  let settled = false;
  const pending = command(a, { command: "wait", taskId: own.id }).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await sleep(30);
  assert.equal(settled, false, "后台任务仍在运行，不能提前完成等待");
  assert.equal(
    (await command(a, { command: "cancel", taskId: own.id })).status,
    200,
  );
  const waited = await pending;
  assert.equal(waited.status, 200);
  assert.equal(waited.body.taskId, own.id);
  assert.equal((await read("/api/tasks", b)).tasks[0].id, foreign.id);
  for (const taskId of [-1, "1", 1.5]) {
    assert.equal((await command(a, { command: "wait", taskId })).status, 422);
  }
  assert.equal(
    (await command(a, { command: "wait", taskId: 999999 })).status,
    404,
  );
});

test("后台取消仅中止本会话及其 owned 后代，其他会话的前后台工作继续", async (t) => {
  const {
    ids: [a, b],
    read,
    command,
    spawn,
    hold,
    releaseHold,
    waitFor,
  } = await fixture(t);
  await spawn(a, "A", true);
  await spawn(b, "B", true);
  await hold(b);
  const aGraph = await read("/api/tasks", a);
  const bGraph = await read("/api/tasks", b);
  assert.equal(aGraph.tasks.length, 3);
  assert.equal(bGraph.tasks.filter((row) => row.background).length, 3);
  assert.deepEqual(aGraph.tools, [], "A 不显示 B 的在跑工具");
  const cancelled = await command(a, { command: "cancel", background: true });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(
    cancelled.body.tasks.sort(),
    aGraph.tasks.map((row) => row.id).sort(),
  );
  assert.deepEqual((await read("/api/tasks", a)).tasks, []);
  const remaining = await read("/api/tasks", b);
  assert.deepEqual(
    remaining.tasks.map((row) => row.id).sort(),
    bGraph.tasks.map((row) => row.id).sort(),
  );
  assert.ok(remaining.tools.some((row) => row.name === "hold"));
  assert.equal((await read("/api/state", b)).idle, false);
  assert.equal(
    (await command(a, { command: "cancel", background: true })).body.tasks
      .length,
    0,
  );
  releaseHold();
  await waitFor(async () => (await read("/api/state", b)).idle, "B 的前台完成");
  assert.equal(
    (await read("/api/tasks", b)).tasks.filter((row) => row.background).length,
    3,
  );
});

test("任务管理保留目标校验，远程请求也不能越界", async (t) => {
  const {
    ids: [a, b],
    read,
    command,
    spawn,
  } = await fixture(t);
  await spawn(a, "A", true);
  await spawn(b, "B");
  const own = (await read("/api/tasks", a)).tasks.find(
    (row) => row.conversationId !== a,
  );
  const foreign = (await read("/api/tasks", b)).tasks[0];
  assert.equal(
    (
      await command(a, {
        command: "cancel",
        taskId: own.id,
        sessionId: String(b),
      })
    ).status,
    409,
  );
  assert.equal(
    (await command(a, { command: "cancel", id: b, taskId: foreign.id })).status,
    409,
  );
  const remote = { "x-pi-remote-client": "1" };
  for (const name of ["wait", "cancel"])
    assert.equal(
      (await command(a, { command: name, taskId: foreign.id }, remote)).status,
      404,
    );
  assert.equal(
    (await command(a, { command: "cancel", taskId: own.id }, remote)).status,
    200,
  );
  assert.equal(
    (await command(a, { command: "wait", taskId: own.id }, remote)).status,
    200,
  );
  assert.equal((await read("/api/tasks", b)).tasks[0].id, foreign.id);
});

test("只读宿主允许读图但拒绝等待和取消，拒绝不改变任务", async (t) => {
  const {
    ids: [a],
    read,
    command,
    spawn,
  } = await fixture(t, { readOnly: true });
  await spawn(a, "A");
  const before = await read("/api/tasks", a);
  assert.equal(before.supported, true);
  assert.equal(before.tasks.length, 1);
  for (const input of [
    { command: "wait" },
    { command: "wait", taskId: before.tasks[0].id },
    { command: "cancel", taskId: before.tasks[0].id },
    { command: "cancel", background: true },
  ]) {
    const rejected = await command(a, input);
    assert.equal(rejected.status, 403);
    assert.match(rejected.body.error, /只读/);
  }
  assert.deepEqual((await read("/api/tasks", a)).tasks, before.tasks);
});

test("任务图显示 owned 子会话的在跑工具，且其他顶层会话不可见", async (t) => {
  const {
    ids: [a, b],
    read,
    hold,
    releaseHold,
    waitFor,
  } = await fixture(t);
  await hold(a, { inChild: true });
  const graph = await read("/api/tasks", a);
  const child = graph.conversations[0];
  assert.ok(child);
  assert.ok(
    graph.tools.some(
      (row) => row.name === "hold" && row.conversationId === child.id,
    ),
  );
  assert.deepEqual((await read("/api/tasks", b)).tools, []);
  releaseHold();
  await waitFor(
    async () => (await read("/api/state", a)).idle,
    "owned 子会话完成",
  );
});

test("历史 fork 来源不是任务所有权，取消父会话不影响独立分支", async (t) => {
  const { ids, read, command, spawn } = await fixture(t);
  const a = ids[0];
  await spawn(a, "source", true);
  const point = (await read("/api/state", a)).messages.find(
    (row) => row.text === "source",
  );
  const forked = await command(a, { command: "fork", entryId: point.entryId });
  assert.equal(forked.status, 200);
  const branch = forked.body.id;
  ids.push(branch);
  assert.equal((await read("/api/tree", branch)).forkOf.conversationId, a);
  await spawn(branch, "branch");
  const branchGraph = await read("/api/tasks", branch);
  assert.equal(branchGraph.tasks.length, 1);
  assert.deepEqual(branchGraph.conversations, []);
  assert.equal((await read("/api/tasks", a)).tasks.length, 3);
  await command(a, { command: "cancel", background: true });
  assert.deepEqual((await read("/api/tasks", a)).tasks, []);
  assert.deepEqual((await read("/api/tasks", branch)).tasks, branchGraph.tasks);
});
