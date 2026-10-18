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
import { startDurableDesk } from "../src/server/durable-server.mjs";

/* 任务图与子会话读模型：一个父任务派生「被任务拥有的子会话」（子代理），随后再让一个工具
 * 挂起，断言 /api/tasks 的所有权边、状态、子会话列表与在跑工具。 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "the task graph exposes ownership edges, child sessions and running tools",
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-task-graph-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 10000 });
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "call-sub",
            name: "subagent",
            arguments: { task: "子任务" },
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("子会话回答"),
      fauxAssistantMessage("父会话回答"),
      fauxAssistantMessage(
        [{ type: "toolCall", id: "call-hold", name: "hold", arguments: {} }],
        { stopReason: "toolUse" },
      ),
      // 放行挂起的工具之后还需要一次正常回答，夹具里不留错误路径。
      fauxAssistantMessage("挂起后回答"),
      fauxAssistantMessage("补充回答"),
    ]);
    let releaseHold;
    const holdGate = new Promise((resolve) => (releaseHold = resolve));
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
          // 可控闸门：测试先观察在跑工具，再放行，避免宿主关闭时还在等一个永不结束的任务。
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
      extensions: [Fixture],
      // 夹具只关心任务图；关闭重试，避免 faux 响应耗尽后一直重试导致宿主迟迟不能关闭。
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
    // 宿主关闭等待所有任务结束；夹具若留下未决工作，给关闭一个有界等待，测试仍然收口。
    t.after(() => Promise.race([app.stop(), sleep(5000)]));
    const origin = new URL(app.url).origin;
    const post = async (path, input) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(`${path} ${response.status} ${text.slice(0, 300)}`);
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

    await post("/api/prompt", {
      message: "派生一次",
      sessionId: String(agentId),
    });
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
    assert.equal(
      settledGraph.conversations.length,
      1,
      "the task-owned child conversation stays visible",
    );
    const child = settledGraph.conversations[0];
    assert.ok(
      Number.isSafeInteger(child.owner?.taskId),
      "the owner edge names the task that created the child",
    );
    assert.equal(child.owner?.conversationId, agentId);
    assert.equal(typeof child.name, "string");
    assert.deepEqual(child.parent, null);
    assert.equal(child.idle, true);

    await post("/api/prompt", {
      message: "挂起一次",
      sessionId: String(agentId),
    });
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
    // 任务节点上的 owner 是「拥有它的任务 id」（由会话自己拥有时为 null）。
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
    assert.deepEqual(toolTask.waitingOn, []);
    assert.equal(toolTask.status, "running");

    // 放行挂起的工具：任务图清空，宿主才能正常关闭（取消语义由 task-6 单独覆盖）。
    console.log("STEP 5 released");
    releaseHold();
    await waitFor(async () => {
      const value = await taskGraph();
      return value.tasks.length === 0 ? value : undefined;
    }, "the finished run to leave the task graph");
  },
);
