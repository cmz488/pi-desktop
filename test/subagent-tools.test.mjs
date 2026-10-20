import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { subagentToolFixture } from "./subagent-tool-fixture.mjs";

// 工具必须真实进入 provider 声明并由 Durable 执行，不能直接调用内部 handler 冒充模型调用。
test(
  "内置子代理扩展让模型创建原生后台委托，父会话不等待子代理完成",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const f = await desktopFixture({
      noExtensions: true,
      beforeModelResponse: async (input) => {
        if (
          input.messages.at(-1)?.role === "user" &&
          input.messages.at(-1).content === "TOOL_CHILD_HELD"
        )
          await gate.promise;
      },
      modelReply: async (input) =>
        input.messages.at(-1)?.role === "user" &&
        input.messages.at(-1).content === "ASK_DESK_SUBAGENT"
          ? {
              toolCalls: [
                {
                  id: "spawn-child",
                  type: "function",
                  function: {
                    name: "desk_subagent",
                    arguments: JSON.stringify({
                      action: "spawn",
                      prompt: "TOOL_CHILD_HELD",
                      name: "模型委托",
                    }),
                  },
                },
              ],
            }
          : { text: "PARENT_OR_CHILD_DONE" },
    });
    t.after(async () => {
      gate.resolve();
      await f.close();
    });
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "工具调用父会话",
    });
    const prefix = `/agents/${actor.id}`;
    const initial = await f.call(`${prefix}/api/state`);
    await f.call(`${prefix}/api/prompt?sessionId=${initial.sessionId}`, {
      sessionId: initial.sessionId,
      message: "ASK_DESK_SUBAGENT",
    });
    await until(
      () => f.requests,
      (requests) => requests.length > 0,
    );
    assert.ok(
      f.requests[0].tools?.some(
        (row) => row.function?.name === "desk_subagent",
      ),
      "受管 Agent 的模型请求必须包含内置子代理工具",
    );
    const parent = await until(
      () => f.call(`${prefix}/api/state?sessionId=${initial.sessionId}`),
      (state) =>
        state.idle &&
        state.messages.some((row) => row.toolName === "desk_subagent"),
    );
    const tool = parent.messages.find(
      (row) => row.toolName === "desk_subagent",
    );
    const receipt = JSON.parse(tool.text);
    assert.equal(receipt.parentConversationId, Number(initial.sessionId));
    assert.equal(typeof receipt.taskId, "number");
    const monitor = await until(
      () => f.call(`${prefix}/api/task-monitor?sessionId=${initial.sessionId}`),
      (data) =>
        data.conversations.some((row) => row.owner?.taskId === receipt.taskId),
    );
    const child = monitor.conversations.find(
      (row) => row.owner?.taskId === receipt.taskId,
    );
    assert.equal(child.owner.conversationId, Number(initial.sessionId));
    assert.equal(
      monitor.tasks.find((row) => row.id === receipt.taskId).background,
      true,
    );
    assert.equal(
      monitor.tasks.find((row) => row.id === receipt.taskId).kind,
      "desk.subagent-run",
    );
    assert.equal(
      monitor.conversations.find((row) => row.id === Number(initial.sessionId))
        .idle,
      true,
      "创建工具返回后后台子代理不保持父会话忙碌",
    );
    assert.equal(
      (await f.call("/api/workspace")).agents.length,
      1,
      "子代理不是额外的 Desktop Agent／worker",
    );
    gate.resolve();
    const detail = await until(
      () =>
        f.call(
          `${prefix}/api/task-detail?sessionId=${initial.sessionId}&taskId=${receipt.taskId}`,
        ),
      (value) => value.task.status === "terminal",
    );
    assert.equal(detail.task.outcome.status, "completed");
    assert.equal(detail.task.outcome.result.answer, "PARENT_OR_CHILD_DONE");
    assert.equal(
      f.requests.length,
      3,
      "父模型工具回合与后续答复、子模型各执行一次，不另跑 SDK 模型循环",
    );
  },
);

test(
  "模型读取子代理的原生终态、回答绑定与受限消息",
  { timeout: 60000 },
  async (t) => {
    const { f, actor, prefix, parent, invoke } = await subagentToolFixture(t);
    const spawned = await invoke({
      action: "spawn",
      prompt: "child read result",
      name: "可读子代理",
    });
    const settled = await until(
      () =>
        f.call(
          `${prefix}/api/task-detail?sessionId=${parent}&taskId=${spawned.taskId}`,
        ),
      (value) => value.task.status === "terminal",
    );
    const result = await invoke({ action: "read", taskId: spawned.taskId });
    assert.deepEqual(
      result.task,
      settled.task,
      "模型读取与公开 HTTP 详情使用同一原生安全回执",
    );
    assert.equal(result.children[0].id, settled.children[0].id);
    assert.ok(
      result.children[0].messages.some(
        (row) => row.role === "assistant" && row.text === "NATIVE_TOOL_DONE",
      ),
    );
    assert.equal(
      result.task.outcome.result.answerEntryId,
      settled.task.outcome.result.answerEntryId,
    );
    assert.equal(
      JSON.stringify(result).includes('"checkpoint"'),
      false,
      "不泄漏原生检查点或任意任务输入",
    );
  },
);

test(
  "模型 steer 进入原生队列并在工具轮次后交给同一子代理",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const { f, prefix, parent, invoke } = await subagentToolFixture(t, {
      release: () => gate.resolve(),
      beforeModelResponse: async (input) => {
        if (input.messages.at(-1)?.content === "CHILD_STEER")
          await gate.promise;
      },
      modelReply: async (input) =>
        input.messages.at(-1)?.content === "CHILD_STEER"
          ? {
              toolCalls: [
                {
                  id: "child-read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: JSON.stringify({
                      path: "skills/fixture-skill/SKILL.md",
                    }),
                  },
                },
              ],
            }
          : {
              text: input.messages.some((row) => row.content === "STEER_NATIVE")
                ? "STEER_APPLIED"
                : "PARENT_DONE",
            },
    });
    const spawned = await invoke({ action: "spawn", prompt: "CHILD_STEER" });
    await until(
      () => f.requests,
      (requests) =>
        requests.some((row) => row.messages.at(-1)?.content === "CHILD_STEER"),
    );
    const sent = await invoke({
      action: "message",
      taskId: spawned.taskId,
      message: "STEER_NATIVE",
      mode: "steer",
    });
    assert.equal(typeof sent.submissionId, "number");
    assert.equal(sent.mode, "steer");
    gate.resolve();
    const detail = await until(
      () =>
        f.call(
          `${prefix}/api/task-detail?sessionId=${parent}&taskId=${spawned.taskId}`,
        ),
      (value) => value.task.status === "terminal",
    );
    assert.equal(detail.task.outcome.status, "completed");
    assert.ok(
      detail.children[0].messages.some(
        (row) => row.role === "user" && row.text === "STEER_NATIVE",
      ),
    );
    assert.ok(
      detail.children[0].messages.some(
        (row) => row.toolName === "read" && !row.text.includes("Unknown tool"),
      ),
      "子代理仍使用自己的 Pi 原生工具 scope",
    );
    assert.equal(detail.task.outcome.result.answer, "STEER_APPLIED");
  },
);

test(
  "模型列举只返回当前 owned 范围，终态默认移出实时清单但可显式查历史",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const { f, prefix, parent, actor, invoke } = await subagentToolFixture(t, {
      release: () => gate.resolve(),
      beforeModelResponse: async (input) => {
        if (input.messages.at(-1)?.content === "LIST_CHILD_HELD")
          await gate.promise;
      },
    });
    const spawned = await invoke({
      action: "spawn",
      prompt: "LIST_CHILD_HELD",
    });
    const branch = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
    });
    const foreign = await invoke(
      { action: "list" },
      { sessionId: branch.sessionId },
    );
    assert.deepEqual(
      foreign.tasks,
      [],
      "历史 fork 不获得父会话的子代理管理范围",
    );
    const running = await invoke({ action: "list" });
    assert.deepEqual(
      running.tasks.map((row) => row.id),
      [spawned.taskId],
    );
    gate.resolve();
    await until(
      () =>
        f.call(
          `${prefix}/api/task-detail?sessionId=${parent}&taskId=${spawned.taskId}`,
        ),
      (value) => value.task.status === "terminal",
    );
    assert.deepEqual((await invoke({ action: "list" })).tasks, []);
    const history = await invoke({ action: "list", includeTerminal: true });
    assert.equal(history.tasks[0].outcome.status, "completed");
    const denied = await invoke(
      { action: "read", taskId: spawned.taskId },
      { sessionId: branch.sessionId, error: true },
    );
    assert.match(denied, /任务不存在/);
    assert.equal(denied.includes("NATIVE_TOOL_DONE"), false);
  },
);

test(
  "模型等待透传原生终态，观察期间不伪造完成",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const { f, prefix, parent, invoke } = await subagentToolFixture(t, {
      release: () => gate.resolve(),
      beforeModelResponse: async (input) => {
        if (input.messages.at(-1)?.content === "WAIT_CHILD_HELD")
          await gate.promise;
      },
    });
    const spawned = await invoke({
      action: "spawn",
      prompt: "WAIT_CHILD_HELD",
    });
    let returned = false;
    const waiting = invoke({ action: "wait", taskId: spawned.taskId }).then(
      (value) => {
        returned = true;
        return value;
      },
    );
    const active = await until(
      () => f.call(`${prefix}/api/state?sessionId=${parent}`),
      (value) =>
        !value.idle &&
        value.activeCalls?.some((row) => row.name === "desk_subagent"),
    );
    assert.equal(active.idle, false);
    assert.equal(
      returned,
      false,
      "原生子代理未终结前，管理工具不能提前返回成功",
    );
    gate.resolve();
    const result = await waiting;
    assert.equal(result.task.id, spawned.taskId);
    assert.equal(result.task.status, "terminal");
    assert.equal(result.task.outcome.status, "completed");
  },
);

test(
  "模型中止只控制 owned 子代理并返回原生回执，历史分支不能跨范围中止",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    const { f, actor, prefix, parent, invoke } = await subagentToolFixture(t, {
      release: () => gate.resolve(),
      beforeModelResponse: async (input) => {
        if (input.messages.at(-1)?.content === "ABORT_CHILD_HELD")
          await gate.promise;
      },
    });
    const spawned = await invoke({
      action: "spawn",
      prompt: "ABORT_CHILD_HELD",
    });
    const branch = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
    });
    const denied = await invoke(
      { action: "abort", taskId: spawned.taskId },
      { sessionId: branch.sessionId, error: true },
    );
    assert.match(denied, /任务不存在/);
    const before = await f.call(
      `${prefix}/api/task-detail?sessionId=${parent}&taskId=${spawned.taskId}`,
    );
    assert.notEqual(before.task.status, "terminal");
    const stopped = await invoke({ action: "abort", taskId: spawned.taskId });
    assert.ok(["marked", "terminal"].includes(stopped.abortStatus));
    const terminal = await invoke({ action: "wait", taskId: spawned.taskId });
    assert.equal(terminal.task.outcome.status, "aborted");
    assert.equal((await invoke({ action: "list" })).tasks.length, 0);
    gate.resolve();
  },
);

test(
  "子代理工具公开原生配置选择，同一 requestId 重试不重复创建",
  { timeout: 60000 },
  async (t) => {
    const { f, prefix, parent, invoke } = await subagentToolFixture(t);
    const args = {
      action: "spawn",
      prompt: "CONFIG_CHILD",
      requestId: "model-idempotent",
      config: {
        instructions: "CHILD_CONFIG_PROOF",
        tools: ["read"],
        model: { provider: "desktop-fixture", modelId: "local" },
      },
    };
    const first = await invoke(args);
    assert.ok(
      f.requests[0].tools.find((row) => row.function?.name === "desk_subagent")
        .function.parameters.properties.config,
      "模型工具声明必须公开已支持的原生配置，而不是接受未声明参数",
    );
    const second = await invoke(args);
    assert.equal(first.taskId, second.taskId);
    await until(
      () =>
        f.call(
          `${prefix}/api/task-detail?sessionId=${parent}&taskId=${first.taskId}`,
        ),
      (value) => value.task.status === "terminal",
    );
    const child = f.requests.find(
      (row) => row.messages.at(-1)?.content === "CONFIG_CHILD",
    );
    assert.deepEqual(
      child.tools.map((row) => row.function.name),
      ["read"],
    );
    assert.ok(
      child.messages.some(
        (row) =>
          row.role === "system" && row.content.includes("CHILD_CONFIG_PROOF"),
      ),
    );
    const denied = await invoke(
      { ...args, prompt: "DIFFERENT_CHILD" },
      { error: true },
    );
    assert.match(denied, /请求 ID 已用于其他内容/);
  },
);
