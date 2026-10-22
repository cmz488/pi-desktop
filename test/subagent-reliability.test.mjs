import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";

async function setup(t, options = {}) {
  const { beforeAgent, ...fixtureOptions } = options;
  const f = await desktopFixture({ noExtensions: true, ...fixtureOptions });
  t.after(() => f.close());
  await beforeAgent?.(f);
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "子代理可靠性",
  });
  const prefix = `/agents/${actor.id}`;
  const parent = (await f.call(`${prefix}/api/state`)).sessionId;
  const spawn = (requestId, config = {}) =>
    f.call(`${prefix}/api/command`, {
      command: "subagent.spawn",
      id: Number(parent),
      sessionId: parent,
      requestId,
      prompt: "CHILD_WRITE_WITH_APPROVAL",
      name: "需要确认的子代理",
      config,
    });
  const detail = (taskId) =>
    f.call(`${prefix}/api/task-detail?sessionId=${parent}&taskId=${taskId}`);
  return { f, actor, prefix, parent, spawn, detail };
}

test(
  "子代理继承持久审批策略，父会话可确认 owned 交互且不能回答其他会话",
  { timeout: 60000 },
  async (t) => {
    const { f, actor, prefix, parent, spawn, detail } = await setup(t, {
      modelReply: async (input) =>
        input.messages.at(-1)?.content === "CHILD_WRITE_WITH_APPROVAL"
          ? {
              toolCalls: [
                {
                  id: "child-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      path: "approval-proof.txt",
                      content: "批准后写入",
                    }),
                  },
                },
              ],
            }
          : { text: "DONE" },
    });
    await f.call(`${prefix}/api/prompt?sessionId=${parent}`, {
      sessionId: parent,
      message: "建立可分叉的父会话",
    });
    await until(
      () => f.call(`${prefix}/api/state?sessionId=${parent}`),
      (value) =>
        value.idle && value.messages.some((row) => row.text === "DONE"),
    );
    await f.command("agent.policy", { id: actor.id, mode: "ask-all" });
    const first = await spawn("approval-denied", { tools: ["write"] });
    async function pending(taskId) {
      const state = await until(
        async () => ({
          detail: await detail(taskId),
          interactions: await f.call(
            `${prefix}/api/interactions?sessionId=${parent}`,
          ),
        }),
        (value) =>
          value.detail.task.status === "terminal" ||
          value.interactions.rows.some((row) => row.prompt),
      );
      const job = state.interactions.rows.find((row) => row.prompt);
      assert.ok(job, "子代理写入必须等待父会话可见的确认，不能静默沿用 YOLO");
      assert.match(job.label, /需要确认的子代理/);
      assert.equal(job.sourceConversationId, state.detail.children[0].id);
      return job;
    }
    const denied = await pending(first.taskId);
    await assert.rejects(readFile(join(f.cwd, "approval-proof.txt")), {
      code: "ENOENT",
    });
    const branch = await f.legacyFork(actor.id, parent, { mode: "tail" });
    assert.equal(
      (await f.call(`${prefix}/api/interactions?sessionId=${branch.sessionId}`))
        .rows.length,
      0,
    );
    await assert.rejects(
      f.call(`${prefix}/api/interaction-reply?sessionId=${branch.sessionId}`, {
        id: denied.id,
        promptId: denied.prompt.id,
        value: "yes",
      }),
      (error) => error.status === 404,
    );
    await f.call(`${prefix}/api/interaction-reply?sessionId=${parent}`, {
      id: denied.id,
      promptId: denied.prompt.id,
      value: denied.prompt.options.find((row) => row.label === "取消").id,
    });
    await until(
      () => detail(first.taskId),
      (value) => value.task.status === "terminal",
    );
    await assert.rejects(readFile(join(f.cwd, "approval-proof.txt")), {
      code: "ENOENT",
    });
    await f.command("agent.policy", { id: actor.id, mode: "yolo" });
    await f.command("agent.stop", { id: actor.id });
    await f.command("agent.policy", { id: actor.id, mode: "ask-all" });
    await f.reopen();
    await f.command("agent.start", { id: actor.id });
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.id === actor.id && row.status === "running",
        ),
    );
    const next = await spawn("approval-after-restart", { tools: ["write"] });
    const allowed = await pending(next.taskId);
    await f.call(`${prefix}/api/interaction-reply?sessionId=${parent}`, {
      id: allowed.id,
      promptId: allowed.prompt.id,
      value: allowed.prompt.options.find((row) => row.label === "确认").id,
    });
    await until(
      () => detail(next.taskId),
      (value) => value.task.status === "terminal",
    );
    assert.equal(
      await readFile(join(f.cwd, "approval-proof.txt"), "utf8"),
      "批准后写入",
    );
  },
);

test(
  "终态子代理释放原生资源，重启与历史详情不重新装载历史宿主",
  { timeout: 60000 },
  async (t) => {
    let events;
    const { f, actor, prefix, parent, spawn, detail } = await setup(t, {
      noExtensions: false,
      beforeAgent: async (f) => {
        events = join(f.cwd, "resource-lifecycle.log");
        await writeFile(events, "");
        const extension = join(f.cwd, "lifecycle.mjs");
        await writeFile(
          extension,
          `import {appendFileSync} from "node:fs"; export default pi => {
        pi.on("session_start", () => appendFileSync(${JSON.stringify(events)}, "start\\n"));
        pi.on("session_shutdown", () => appendFileSync(${JSON.stringify(events)}, "stop\\n"));
      };`,
        );
        const path = join(f.agentDir, "settings.json");
        const settings = JSON.parse(await readFile(path, "utf8"));
        await writeFile(
          path,
          JSON.stringify({ ...settings, extensions: [extension] }),
        );
      },
    });
    const created = await spawn("release-owned-resources");
    await until(
      () => detail(created.taskId),
      (value) => value.task.status === "terminal",
    );
    const settled = await until(
      () => readFile(events, "utf8"),
      (value) => value.includes("stop"),
      2000,
    );
    assert.equal((settled.match(/start/g) ?? []).length, 2);
    assert.equal((settled.match(/stop/g) ?? []).length, 1);
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.id === actor.id && row.status === "running",
        ),
    );
    await f.call(`${prefix}/api/subagent-history?sessionId=${parent}`);
    const historical = await detail(created.taskId);
    assert.equal(historical.task.outcome.status, "completed");
    assert.equal(
      (await readFile(events, "utf8")).match(/start/g).length,
      3,
      "只重建父会话资源；读历史不创建新资源 Session",
    );
  },
);

test(
  "子代理回合预算在原生请求边界停止循环，重启不会重置已用回合",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    let requests = 0;
    const { f, actor, spawn, detail } = await setup(t, {
      beforeModelResponse: async () => {
        if (++requests === 3) await gate.promise;
      },
      modelReply: async () => ({
        toolCalls: [
          {
            id: "repeat-read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({
                path: "skills/fixture-skill/SKILL.md",
              }),
            },
          },
        ],
      }),
    });
    const config = { tools: ["read"], maxTurns: 3 };
    const started = await spawn("bounded-turns", config);
    await until(
      () => f.requests.length,
      (value) => value === 3,
    );
    await f.reopen();
    gate.resolve();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.id === actor.id && row.status === "running",
        ),
    );
    const ended = await until(
      () => detail(started.taskId),
      (value) => value.task.status === "terminal",
      3000,
    );
    assert.equal(ended.task.outcome.status, "failed");
    assert.match(ended.task.outcome.error.message, /回合预算/);
    assert.ok(
      f.requests.length <= 4,
      "最多重放一次在途请求，不能在重启后再跑满一轮预算",
    );
    const used = f.requests.length;
    assert.equal((await spawn("bounded-turns", config)).taskId, started.taskId);
    assert.equal(f.requests.length, used);
  },
);

test(
  "并发配额覆盖整棵委托树，子代理不能通过递归绕过上限",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const { f, prefix, parent, spawn, detail } = await setup(t, {
      beforeModelResponse: () => gate.promise,
    });
    const first = await spawn("tree-quota-0");
    const child = (
      await until(
        () => detail(first.taskId),
        (value) => value.children.length > 0,
      )
    ).children[0].id;
    for (let index = 1; index < 16; index++) await spawn(`tree-quota-${index}`);
    await assert.rejects(
      f.call(`${prefix}/api/command?sessionId=${child}`, {
        command: "subagent.spawn",
        id: child,
        sessionId: String(child),
        requestId: "quota-bypass",
        prompt: "不应启动的孙代理",
      }),
      (error) => error.status === 429,
    );
    const retry = await spawn("tree-quota-0");
    assert.equal(retry.taskId, first.taskId, "达到配额后仍可取回已有请求");
    gate.resolve();
  },
);

test(
  "嵌套深度在持久准入处限制，不能继续创建第四层子代理",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const { f, prefix, parent } = await setup(t, {
      beforeModelResponse: () => gate.promise,
    });
    let owner = Number(parent);
    for (let depth = 1; depth <= 3; depth++) {
      const started = await f.call(`${prefix}/api/command?sessionId=${owner}`, {
        command: "subagent.spawn",
        id: owner,
        sessionId: String(owner),
        requestId: `depth-${depth}`,
        prompt: "深度夹具",
      });
      const result = await until(
        () =>
          f.call(
            `${prefix}/api/task-detail?sessionId=${owner}&taskId=${started.taskId}`,
          ),
        (value) => value.children.length > 0,
      );
      owner = result.children[0].id;
    }
    await assert.rejects(
      f.call(`${prefix}/api/command?sessionId=${owner}`, {
        command: "subagent.spawn",
        id: owner,
        sessionId: String(owner),
        requestId: "depth-4",
        prompt: "超深度",
      }),
      (error) => error.status === 429 && /嵌套深度/.test(error.message),
    );
    gate.resolve();
  },
);

test(
  "Host 收紧审批覆盖既有分支及旧位置的新分叉，但不影响其他 worker",
  { timeout: 60000 },
  async (t) => {
    const { f, actor, prefix, parent } = await setup(t, {
      modelReply: async (input) =>
        input.messages.at(-1)?.content === "BRANCH_POLICY_WRITE"
          ? {
              toolCalls: [
                {
                  id: "branch-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({
                      path: "branch-policy-proof.txt",
                      content: "不应写入",
                    }),
                  },
                },
              ],
            }
          : { text: "DONE" },
    });
    await f.call(`${prefix}/api/prompt?sessionId=${parent}`, {
      sessionId: parent,
      message: "权限变更前的分叉位置",
    });
    const before = await until(
      () => f.call(`${prefix}/api/state?sessionId=${parent}`),
      (value) =>
        value.idle && value.messages.some((row) => row.text === "DONE"),
    );
    const oldEntry = before.messages.find((row) => row.role === "user").entryId;
    const existing = await f.legacyFork(actor.id, parent, { mode: "tail" });
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const peer = await f.command("conversation.create", {
      projectId: project.id,
      name: "独立权限对照",
    });
    const peerParent = (await f.call(`/agents/${peer.id}/api/state`)).sessionId;
    await f.command("agent.policy", { id: actor.id, mode: "ask-all" });
    const historical = await f.legacyFork(actor.id, parent, {
      entryId: oldEntry,
    });
    assert.equal(
      (await f.call(`/agents/${peer.id}/api/agent?sessionId=${peerParent}`))
        .active.approvalMode,
      "ask-risky",
      "worker 之间不共享审批覆盖",
    );
    for (const sessionId of [existing.sessionId, historical.sessionId]) {
      assert.equal(
        (await f.call(`${prefix}/api/agent?sessionId=${sessionId}`)).active
          .approvalMode,
        "ask-all",
        "历史配置不能恢复旧权限",
      );
      const created = await f.call(
        `${prefix}/api/command?sessionId=${sessionId}`,
        {
          command: "subagent.spawn",
          id: Number(sessionId),
          sessionId,
          requestId: `branch-policy-${sessionId}`,
          prompt: "BRANCH_POLICY_WRITE",
          config: { tools: ["write"] },
        },
      );
      const observed = await until(
        async () => ({
          detail: await f.call(
            `${prefix}/api/task-detail?sessionId=${sessionId}&taskId=${created.taskId}`,
          ),
          jobs: await f.call(
            `${prefix}/api/interactions?sessionId=${sessionId}`,
          ),
        }),
        (value) =>
          value.detail.task.status === "terminal" ||
          value.jobs.rows.some((row) => row.prompt),
      );
      const job = observed.jobs.rows.find((row) => row.prompt);
      assert.ok(job, "分支的子代理必须先等待批准");
      await assert.rejects(readFile(join(f.cwd, "branch-policy-proof.txt")), {
        code: "ENOENT",
      });
      await f.call(`${prefix}/api/interaction-reply?sessionId=${sessionId}`, {
        id: job.id,
        promptId: job.prompt.id,
        value: job.prompt.options.find((row) => row.label === "取消").id,
      });
      await until(
        () =>
          f.call(
            `${prefix}/api/task-detail?sessionId=${sessionId}&taskId=${created.taskId}`,
          ),
        (value) => value.task.status === "terminal",
      );
    }
    await assert.rejects(readFile(join(f.cwd, "branch-policy-proof.txt")), {
      code: "ENOENT",
    });
  },
);
