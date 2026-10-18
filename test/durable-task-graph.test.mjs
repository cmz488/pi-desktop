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
  configure,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { createBackgroundFixture } from "./background-fixture.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";

/* 任务图与子会话读模型，以及任务管理操作（等待／取消／只读拒绝）。
 * 夹具用一个「任务拥有的子会话」模拟子代理，再用一个可控闸门的工具制造可观察的在跑任务；
 * 每个阶段的 faux 响应都用 setResponses 重设，保证请求顺序与回答都是确定的。 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "the task graph exposes ownership and child sessions, and tasks can be waited on or cancelled",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-task-graph-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 10000 });
    models.setProvider(faux.provider);
    let releaseHold;
    let holdGate = new Promise((resolve) => (releaseHold = resolve));
    const toolCall = (id, name, args) =>
      fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args }], {
        stopReason: "toolUse",
      });
    const backgroundFixture = createBackgroundFixture();
    const Fixture = defineExtension({
      name: "subagent-fixture",
      tools: [
        defineTool({
          name: "subagent",
          description: "派生一个子会话并把它的结果带回来",
          parameters: Type.Object({ task: Type.String() }),
          replay: "safe",
          execute: async (args, api, context) => {
            const child = await api.commit(async (tx) => {
              const existing = (
                await tx.scanConversations({ ownerTaskId: api.taskId }, 1)
              ).items[0];
              if (existing !== undefined) return existing.id;
              const created = await tx.createConversation({
                ownership: { kind: "task", taskId: api.taskId },
              });
              // 子会话不继承 subagent 工具，否则会无限递归派生。
              await configure(tx, created.id, {
                extensions: { remove: [Fixture] },
              });
              return created.id;
            }, context);
            await api.details({ conversationId: child }, context);
            const handle = await api.conversation(child, context);
            const settled = await (
              await handle.submit(
                {
                  type: "input",
                  content: args.task,
                  requestId: `subagent:${api.taskId}`,
                },
                context,
              )
            ).wait(context);
            return { content: [{ type: "text", text: settled.status }] };
          },
        }),
        defineTool({
          name: "hold",
          // 可控闸门：先观察在跑任务，再放行或取消，避免夹具有永不结算的工作。
          parameters: Type.Object({}),
          execute: async () => {
            await holdGate;
            return { content: [{ type: "text", text: "released" }] };
          },
        }),
      ],
    });
    const workspace = await openAgentWorkspace({
      storage: new MemoryStorage(),
      models,
      extensions: [Fixture, backgroundFixture.extension],
      // 夹具只关心任务；关闭重试，避免响应耗尽后一直重试而拖住关闭。
      settings: { retry: { enabled: false } },
    });
    const agentId = (
      await workspace.execute("create", {
        cwd,
        name: "任务夹具",
        model: { provider: faux.provider.id, modelId: faux.models[0].id },
      })
    ).id;
    const app = await startDurableDesk({
      workspace,
      port: 0,
      agentDir: join(root, "agent"),
      directory: join(root, "agent", "desktop"),
      resources: false,
    });
    t.after(() => Promise.race([app.stop(), sleep(5000)]));
    const origin = new URL(app.url).origin;
    const post = async (path, input, base = origin) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!response.ok)
        throw Object.assign(
          new Error(`${path} ${response.status} ${text.slice(0, 200)}`),
          {
            status: response.status,
            body: text,
          },
        );
      return text ? JSON.parse(text) : {};
    };
    const state = async () =>
      await (await fetch(`${origin}/api/state?id=${agentId}`)).json();
    const taskGraph = async () =>
      await (await fetch(`${origin}/api/tasks?id=${agentId}`)).json();
    const waitFor = async (predicate, label) => {
      for (let index = 0; index < 400; index++) {
        const value = await predicate();
        if (value) return value;
        await sleep(25);
      }
      throw new Error(`timeout waiting for ${label}`);
    };
    const prompt = (message) =>
      post("/api/prompt", { message, sessionId: String(agentId) });

    // 阶段一：子代理派生一个被任务拥有的子会话，随后回到空闲。
    faux.setResponses([
      toolCall("call-sub", "subagent", { task: "子任务" }),
      fauxAssistantMessage("子会话回答"),
      fauxAssistantMessage("父会话回答"),
    ]);
    await prompt("派生一次");
    await waitFor(async () => {
      const current = await state();
      return (
        current.idle &&
        current.messages.some((row) => row.text === "父会话回答")
      );
    }, "the parent answer");

    const settledGraph = await taskGraph();
    assert.equal(settledGraph.supported, true);
    assert.equal(settledGraph.sessionId, String(agentId));
    assert.deepEqual(
      settledGraph.tasks,
      [],
      "an idle session keeps no live task",
    );
    assert.equal(settledGraph.conversations.length, 1);
    const child = settledGraph.conversations[0];
    assert.ok(
      Number.isSafeInteger(child.owner?.taskId),
      "the child conversation records the task that created it",
    );
    assert.equal(child.owner?.conversationId, agentId);
    assert.equal(typeof child.name, "string");
    assert.deepEqual(child.parent, null);
    assert.equal(child.idle, true);

    // 阶段一之二：真实的后台任务。会话不必为空闲等待它，取消后台任务能让它进入终态。
    faux.setResponses([
      toolCall("call-anchor", "background_work", {}),
      fauxAssistantMessage("后台已派生"),
    ]);
    await prompt("派生后台任务");
    await waitFor(
      async () =>
        (await state()).messages.some((row) => row.text === "后台已派生"),
      "the turn that spawned the background task",
    );
    const withAnchor = await waitFor(async () => {
      const value = await taskGraph();
      return value.tasks.some((row) => row.background) ? value : undefined;
    }, "the background task to appear");
    const anchor = withAnchor.tasks.find((row) => row.background);
    assert.equal(anchor.kind, "fixture.anchor");
    assert.equal(
      anchor.owner,
      null,
      "a conversation-owned task has no owning task",
    );
    assert.equal(
      (await state()).idle,
      true,
      "a background task does not keep the conversation busy",
    );
    const cleared = await post("/api/command", {
      command: "cancel",
      id: agentId,
      sessionId: String(agentId),
      background: true,
    });
    assert.deepEqual(
      cleared.tasks.map(String),
      [String(anchor.id)],
      "the background cancel names the task it cancelled",
    );
    await waitFor(async () => {
      const value = await taskGraph();
      return value.tasks.length === 0 ? value : undefined;
    }, "the cancelled background task to leave the task graph");
    assert.equal((await state()).idle, true);

    // 阶段二：挂起的工具进入任务图与在跑工具，随后按任务 id 取消它。
    faux.setResponses([toolCall("call-hold", "hold", {})]);
    faux.appendResponses([fauxAssistantMessage("取消后回答")]);
    await prompt("挂起一次");
    const running = await waitFor(async () => {
      const value = await taskGraph();
      return value.tools.some((row) => row.name === "hold") ? value : undefined;
    }, "the hanging tool to appear in the task graph");
    const tool = running.tools.find((row) => row.name === "hold");
    assert.equal(tool.conversationId, agentId);
    assert.notEqual(tool.status, "done");
    const toolTask = running.tasks.find((row) => row.kind === "pi.tool");
    const generation = running.tasks.find(
      (row) => row.kind === "pi.generation",
    );
    assert.ok(toolTask && generation, "tool and generation tasks are live");
    assert.equal(
      String(toolTask.owner),
      String(generation.id),
      "the tool task is owned by its generation",
    );
    assert.deepEqual(
      generation.waitingOn.map(String),
      [String(toolTask.id)],
      "the generation waits for the tool it owns",
    );
    assert.equal(
      generation.owner,
      null,
      "the generation is owned by its conversation, so it has no owning task",
    );
    assert.equal(toolTask.background, false);

    // Durable 会等被取消的任务结算，所以先发起取消，再放行工具让这次等待有终点。
    const cancelCall = post("/api/command", {
      command: "cancel",
      id: agentId,
      sessionId: String(agentId),
      taskId: toolTask.id,
    });
    releaseHold();
    const cancelled = await cancelCall;
    assert.equal(cancelled.cancelled, true);
    assert.equal(String(cancelled.taskId), String(toolTask.id));
    const drained = await waitFor(async () => {
      const value = await taskGraph();
      return value.tasks.length === 0 ? value : undefined;
    }, "the cancelled run to leave the task graph");
    assert.equal(
      drained.conversations.length,
      1,
      "cancelling a task leaves no orphan: the child conversation stays",
    );
    assert.equal(
      (await state()).idle,
      true,
      "cancelling the tool task lets the conversation settle",
    );

    // 阶段三：等待一次前台任务——wait 返回时回答已经提交。
    holdGate = new Promise((resolve) => (releaseHold = resolve));
    faux.setResponses([toolCall("call-hold-2", "hold", {})]);
    const waiting = prompt("等一次");
    await waitFor(async () => {
      const current = await taskGraph();
      return current.tools.some((row) => row.name === "hold");
    }, "the second hanging tool");
    faux.appendResponses([fauxAssistantMessage("等待完成")]);
    const waitCall = post("/api/command", {
      command: "wait",
      id: agentId,
      sessionId: String(agentId),
    });
    await sleep(120);
    assert.equal(
      (await state()).idle,
      false,
      "the wait returns only after the run settles",
    );
    releaseHold();
    const outcome = await Promise.race([
      waitCall.then(() => "settled"),
      sleep(8000).then(() => "timeout"),
    ]);
    assert.equal(outcome, "settled", "wait resolves once the run settles");
    const waited = await waitCall;
    assert.equal(waited.idle, true);
    const settledState = await state();
    assert.ok(
      settledState.idle &&
        settledState.messages.some((row) => row.text === "等待完成"),
      "the wait resolves once the answer is committed",
    );
    await waiting;

    // 阶段四：后台取消只作用于后台任务，前台运行不受影响（用有界等待把挂起变成失败）。
    holdGate = new Promise((resolve) => (releaseHold = resolve));
    faux.setResponses([toolCall("call-hold-3", "hold", {})]);
    faux.appendResponses([fauxAssistantMessage("收尾回答")]);
    await prompt("后台取消一次");
    await waitFor(async () => {
      const value = await taskGraph();
      return value.tools.some((row) => row.name === "hold");
    }, "the third hanging tool");
    const background = await Promise.race([
      post("/api/command", {
        command: "cancel",
        id: agentId,
        sessionId: String(agentId),
        background: true,
      }),
      sleep(8000).then(() => "timeout"),
    ]);
    assert.notEqual(background, "timeout", "a background cancel returns");
    assert.equal(background.background, true);
    assert.equal(
      (await state()).idle,
      false,
      "a background cancel leaves the foreground task running",
    );
    releaseHold();
    await waitFor(
      async () => (await state()).idle,
      "the released run to finish",
    );
    await waitFor(async () => {
      const value = await taskGraph();
      return value.tasks.length === 0 ? value : undefined;
    }, "the released run to drain the graph");

    await assert.rejects(
      post("/api/command", {
        command: "wait",
        id: agentId,
        sessionId: String(agentId),
        taskId: 999999,
      }),
      (error) => error.status === 404,
      "waiting for an unknown task is rejected",
    );

    // 只读宿主拒绝任务管理：等待/取消是写操作，其他命令不受影响。
    const readOnly = await startDurableDesk({
      workspace,
      port: 0,
      readOnly: true,
      resources: false,
    });
    try {
      const base = new URL(readOnly.url).origin;
      await assert.rejects(
        post(
          "/api/command",
          { command: "cancel", id: agentId, sessionId: String(agentId) },
          base,
        ),
        (error) =>
          error.status === 403 && /只读/.test(JSON.parse(error.body).error),
        "a read-only host refuses task management",
      );
    } finally {
      await readOnly.stop();
    }
  },
);
