import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";

const OBSERVER_QUOTA = 32;
const OBSERVATION_SETTLE_MS = 50;
const CONFIG_PROBE_MS = 2000;

async function setup(t, options = {}) {
  const { beforeAgents, ...fixtureOptions } = options;
  const f = await desktopFixture({ noExtensions: true, ...fixtureOptions });
  t.after(() => f.close());
  await beforeAgents?.(f);
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const a = await f.command("conversation.create", {
    projectId: project.id,
    name: "Monitor A",
  });
  const b = await f.command("conversation.create", {
    projectId: project.id,
    name: "Monitor B",
  });
  const request = async (path, input, options = {}) => {
    const response = await fetch(new URL(path, f.app.url), {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Origin: new URL(f.app.url).origin,
        ...(input === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { f, a, b, request };
}

test(
  "Host 聚合真实 worker 的原生任务监控，停止的 worker 不会被监控自动启动",
  { timeout: 60000 },
  async (t) => {
    const { f, a, b, request } = await setup(t);
    const first = await request("/api/host/tasks");
    assert.equal(first.status, 200, "Host 提供跨 worker 的任务监控接口");
    assert.equal(first.body.supported, true);
    assert.equal(first.body.workers.length, 2);
    for (const id of [a.id, b.id]) {
      const worker = first.body.workers.find((row) => row.agentId === id);
      assert.equal(worker.status, "running");
      assert.equal(worker.data.supported, true);
      assert.equal(worker.data.capabilities.taskInspection, true);
      assert.deepEqual(worker.data.tasks, []);
      assert.equal(worker.data.conversations.length, 1);
    }
    assert.equal(f.requests.length, 0, "监控不调用模型或触发工作");
    await f.command("agent.stop", { id: b.id });
    const next = (await request("/api/host/tasks")).body;
    const stopped = next.workers.find((row) => row.agentId === b.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.data, null, "无法读取的 worker 不伪装成任务已完成");
    assert.equal(
      (await f.call("/api/workspace")).agents.find((row) => row.id === b.id)
        .status,
      "stopped",
    );
    const remote = await request("/api/host/tasks", undefined, {
      headers: { "x-pi-remote-client": "1" },
    });
    assert.equal(remote.status, 403, "不放宽远程连接的全 Host 访问范围");
  },
);

test(
  "Host 发起原生 owned 子代理，同一请求幂等且不产生第二个 writer",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const { f, a, b, request } = await setup(t, {
      beforeModelResponse: async (input) => {
        if (
          JSON.stringify(input.messages.at(-1)?.content).includes("child held")
        )
          await gate.promise;
      },
    });
    const initial = (await request("/api/host/tasks")).body;
    const parent = initial.workers.find((row) => row.agentId === a.id).data
      .conversations[0].id;
    const pid = (await f.call("/api/workspace")).agents.find(
      (row) => row.id === a.id,
    ).pid;
    const input = {
      command: "subagent.spawn",
      agentId: a.id,
      generation: initial.workers.find((row) => row.agentId === a.id)
        .generation,
      conversationId: parent,
      requestId: "launch-once",
      name: "受控子代理",
      prompt: "child held",
    };
    const launched = await request("/api/host/tasks/command", input);
    assert.equal(launched.status, 200, "Host 通过适配入口发起原生子代理任务");
    assert.equal(typeof launched.body.taskId, "number");
    const again = await request("/api/host/tasks/command", input);
    assert.equal(again.status, 200);
    assert.equal(
      again.body.taskId,
      launched.body.taskId,
      "HTTP 重试不重复发起任务",
    );
    const running = await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers
          .find((row) => row.agentId === a.id)
          ?.data?.tasks.some((task) => task.kind === "pi.generation") &&
        f.requests.length === 1,
    );
    const data = running.workers.find((row) => row.agentId === a.id).data;
    assert.equal(data.capabilities.spawnSubagent, true);
    const child = data.conversations.find(
      (row) => row.owner?.taskId === launched.body.taskId,
    );
    assert.ok(child, "已执行的子代理必须位于该原生 task 的 owned 会话中");
    assert.equal(child.name, "受控子代理");
    assert.equal(child.owner.conversationId, parent);
    assert.equal(child.scopeId, parent);
    assert.equal(
      data.tasks.find((task) => task.kind === "pi.generation").scopeId,
      parent,
      "原生 owned 工作属于任务管理范围，不依赖历史 parent",
    );
    assert.equal(
      data.tasks.find((row) => row.id === launched.body.taskId).background,
      true,
    );
    assert.equal(
      data.conversations.find((row) => row.id === parent).idle,
      true,
      "后台 owned 工作不冒充父会话前台运行",
    );
    assert.deepEqual(
      running.workers.find((row) => row.agentId === b.id).data.tasks,
      [],
    );
    const catalog = await f.call("/api/workspace");
    assert.equal(catalog.agents.length, 2, "子代理不是新的 Desktop Agent");
    assert.equal(catalog.agents.find((row) => row.id === a.id).pid, pid);
    gate.resolve();
    await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers.find((row) => row.agentId === a.id)?.data?.tasks
          .length === 0,
    );
    const settled = await request("/api/host/tasks/command", input);
    assert.equal(
      settled.body.taskId,
      launched.body.taskId,
      "终态回执仍用于幂等，不靠内存重建状态",
    );
    assert.equal(f.requests.length, 1);
    const details = await request(
      `/api/host/tasks/detail?agentId=${a.id}&generation=${input.generation}&conversationId=${parent}&taskId=${launched.body.taskId}`,
    );
    assert.equal(
      details.status,
      200,
      "任务离开实时图后仍能读取 Durable 终态回执",
    );
    assert.equal(details.body.task.outcome.status, "completed");
    assert.match(details.body.task.outcome.result.answer, /answer: child held/);
    const answer = details.body.children[0].messages.findLast(
      (message) => message.role === "assistant",
    );
    assert.equal(
      details.body.task.outcome.result.answerEntryId,
      answer.entryId,
      "结果指向原生 submission 决定的回答条目，而不是一份无来源文本",
    );
    assert.equal(details.body.children[0].id, child.id);
  },
);

test(
  "Host 等待透传原生任务终态，不把等待成功等同于执行成功",
  { timeout: 60000 },
  async (t) => {
    const { a, request } = await setup(t);
    const worker = (await request("/api/host/tasks")).body.workers.find(
      (row) => row.agentId === a.id,
    );
    const target = {
      agentId: a.id,
      generation: worker.generation,
      conversationId: worker.data.conversations[0].id,
    };
    const launched = await request("/api/host/tasks/command", {
      ...target,
      command: "subagent.spawn",
      requestId: "native-completion-receipt",
      prompt: "NATIVE_RECEIPT",
    });
    assert.equal(launched.status, 200);
    const waited = await request("/api/host/tasks/command", {
      ...target,
      command: "wait",
      taskId: launched.body.taskId,
    });
    assert.equal(waited.status, 200);
    assert.equal(waited.body.task?.status, "terminal", "回执保留原生任务终态");
    assert.equal(waited.body.task.id, launched.body.taskId);
    for (const key of ["input", "checkpoint", "state"])
      assert.equal(
        Object.hasOwn(waited.body.task, key),
        false,
        "命令回执不泄露原始任务输入或检查点",
      );
    assert.equal(waited.body.task.outcome.status, "completed");
    assert.equal(
      waited.body.task.outcome.result.answer,
      "answer: NATIVE_RECEIPT",
    );
    const detail = await request(
      `/api/host/tasks/detail?${new URLSearchParams({ ...target, taskId: launched.body.taskId })}`,
    );
    assert.equal(detail.status, 200);
    assert.deepEqual(
      waited.body.task,
      detail.body.task,
      "等待与详情共享原生任务回执语义",
    );
  },
);

test(
  "Host 中止已完成任务保留原生 terminal 回执，不把成功改写为已中止",
  { timeout: 60000 },
  async (t) => {
    const { a, request } = await setup(t);
    const worker = (await request("/api/host/tasks")).body.workers.find(
      (row) => row.agentId === a.id,
    );
    const target = {
      agentId: a.id,
      generation: worker.generation,
      conversationId: worker.data.conversations[0].id,
    };
    const launched = await request("/api/host/tasks/command", {
      ...target,
      command: "subagent.spawn",
      requestId: "native-terminal-cancel",
      prompt: "ALREADY_DONE",
    });
    const input = { ...target, taskId: launched.body.taskId };
    const waited = await request("/api/host/tasks/command", {
      ...input,
      command: "wait",
    });
    assert.equal(waited.status, 200);
    const cancelled = await request("/api/host/tasks/command", {
      ...input,
      command: "cancel",
    });
    assert.equal(cancelled.status, 200);
    assert.equal(
      cancelled.body.abortStatus,
      "terminal",
      "原生已终态与中止标记分开",
    );
    assert.deepEqual(cancelled.body.task, waited.body.task);
    assert.equal(cancelled.body.task.outcome.status, "completed");
  },
);

test(
  "Host 等待可独立取消，原生子代理中止、只读与存储代际均按目标校验",
  { timeout: 60000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const { f, a, b, request } = await setup(t, {
      beforeModelResponse: async (input) => {
        if (
          JSON.stringify(input.messages.at(-1)?.content).includes("cancel held")
        )
          await gate.promise;
      },
    });
    const worker = (await request("/api/host/tasks")).body.workers.find(
      (row) => row.agentId === a.id,
    );
    const target = {
      agentId: a.id,
      generation: worker.generation,
      conversationId: worker.data.conversations[0].id,
    };
    const launch = {
      ...target,
      command: "subagent.spawn",
      name: "可取消子代理",
      prompt: "cancel held",
      requestId: "cancel-owned",
    };
    const started = await request("/api/host/tasks/command", launch);
    assert.equal(started.status, 200);
    const taskId = started.body.taskId;
    await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers
          .find((row) => row.agentId === a.id)
          ?.data?.tasks.some((row) => row.kind === "pi.generation"),
    );
    const controller = new AbortController();
    let settled = false;
    const waiting = request(
      "/api/host/tasks/command",
      { ...target, command: "wait", taskId },
      { signal: controller.signal },
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, OBSERVATION_SETTLE_MS));
    assert.equal(settled, false);
    let probeTimer;
    try {
      assert.ok(
        await Promise.race([
          f.command("agent.pin", { id: b.id, pinned: true }),
          new Promise((_, reject) => {
            probeTimer = setTimeout(
              () => reject(new Error("等待占用了 Host 配置串行队列")),
              CONFIG_PROBE_MS,
            );
          }),
        ]),
      );
    } finally {
      clearTimeout(probeTimer);
    }
    controller.abort();
    await assert.rejects(waiting, (error) => error.name === "AbortError");
    assert.ok(
      (await request("/api/host/tasks")).body.workers
        .find((row) => row.agentId === a.id)
        .data.tasks.some((row) => row.id === taskId),
      "取消 HTTP 观察后工作仍在运行",
    );
    // 反复断连不能积满原生等待配额；仅检查任务还在，无法证明观察资源已归还。
    for (let index = 0; index <= OBSERVER_QUOTA; index++) {
      const observation = new AbortController();
      const pending = request(
        "/api/host/tasks/command",
        { ...target, command: "wait", taskId },
        { signal: observation.signal },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, OBSERVATION_SETTLE_MS),
      );
      observation.abort();
      const result = await pending;
      assert.equal(
        result.error?.name,
        "AbortError",
        `取消观察必须归还原生配额；第 ${index + 1} 次提前返回 ${result.value?.status}`,
      );
    }
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          ...target,
          generation: target.generation + 1,
          command: "cancel",
          taskId,
        })
      ).status,
      409,
      "旧存储代际不能控制新 worker 的同号任务",
    );
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          ...launch,
          prompt: "different",
        })
      ).status,
      409,
      "同一请求 ID 不接受另一份任务",
    );
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          ...launch,
          requestId: "invalid-config",
          config: { cwd: "/etc" },
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await request(
          "/api/host/tasks/command",
          { ...target, command: "cancel", taskId },
          { headers: { "x-pi-remote-client": "1" } },
        )
      ).status,
      403,
    );
    const readonly = await f.command("conversation.create", {
      name: "readonly native",
    });
    const ro = (await request("/api/host/tasks")).body.workers.find(
      (row) => row.agentId === readonly.id,
    );
    assert.equal(ro.data.capabilities.spawnSubagent, false);
    assert.equal(ro.data.capabilities.manageTasks, false);
    for (const command of ["wait", "cancel"])
      assert.equal(
        (
          await request("/api/host/tasks/command", {
            agentId: readonly.id,
            generation: ro.generation,
            conversationId: ro.data.conversations[0].id,
            command,
            taskId,
          })
        ).status,
        403,
      );
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          agentId: readonly.id,
          generation: ro.generation,
          conversationId: ro.data.conversations[0].id,
          command: "subagent.spawn",
          prompt: "must not run",
          requestId: "ro",
        })
      ).status,
      403,
    );
    for (const bad of [
      { ...launch, requestId: "invalid-null-config", config: null },
      { ...target, taskId: -1, command: "cancel" },
      { ...target, conversationId: "2", taskId, command: "wait" },
      { ...target, generation: undefined, taskId, command: "wait" },
    ])
      assert.equal((await request("/api/host/tasks/command", bad)).status, 422);
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          ...target,
          agentId: "00000000-0000-4000-8000-000000000000",
          command: "cancel",
          taskId,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          ...target,
          command: "cancel",
          taskId: Number.MAX_SAFE_INTEGER,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/api/host/tasks/command", {
          ...target,
          conversationId: 999999,
          command: "cancel",
          taskId,
        })
      ).status,
      404,
    );
    const cancelled = await request("/api/host/tasks/command", {
      ...target,
      command: "cancel",
      taskId,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.abortStatus, "marked");
    assert.equal(cancelled.body.task.id, taskId);
    await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers.find((row) => row.agentId === a.id)?.data?.tasks
          .length === 0,
    );
    const detail = await request(
      "/api/host/tasks/detail?" + new URLSearchParams({ ...target, taskId }),
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.task.outcome.status, "aborted");
    const waited = await request("/api/host/tasks/command", {
      ...target,
      command: "wait",
      taskId,
    });
    assert.equal(waited.status, 200, "等待已中止任务也成功返回观察回执");
    assert.deepEqual(waited.body.task, detail.body.task);
    assert.equal(
      waited.body.task.outcome.status,
      "aborted",
      "等待成功不表示执行成功",
    );
    gate.resolve();
  },
);

test(
  "Host 重启恢复同一 owned 子代理和 submission，并绑定子会话自己的原生工具",
  { timeout: 90000 },
  async (t) => {
    const gate = Promise.withResolvers();
    t.after(() => gate.resolve());
    const { f, a, request } = await setup(t, {
      noExtensions: false,
      beforeAgents: async (f) => {
        const extension = join(f.cwd, "owned-extension.mjs");
        await writeFile(
          extension,
          `import {readFile} from "node:fs/promises";import {join} from "node:path";export default pi=>pi.registerTool({name:"owned_probe",label:"Owned probe",description:"临时项目的原生 scope 回归工具",parameters:{type:"object",properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>({content:[{type:"text",text:await readFile(join(ctx.cwd,"owned-proof.txt"),"utf8")}],details:{}})});`,
        );
        const settingsPath = join(f.agentDir, "settings.json");
        const settings = JSON.parse(await readFile(settingsPath, "utf8"));
        await writeFile(
          settingsPath,
          JSON.stringify({ ...settings, extensions: [extension] }),
        );
      },
      beforeModelResponse: async (input) => {
        if (
          input.messages.at(-1)?.role === "user" &&
          String(input.messages.at(-1).content).includes("read recovery")
        )
          await gate.promise;
      },
      modelReply: async (input) =>
        input.messages.at(-1)?.role === "user"
          ? {
              toolCalls: [
                {
                  id: "owned-read",
                  type: "function",
                  function: {
                    name: "owned_probe",
                    arguments: JSON.stringify({}),
                  },
                },
              ],
            }
          : { text: "原生工具结果：" + input.messages.at(-1).content },
    });
    await writeFile(join(f.cwd, "owned-proof.txt"), "OWNED_NATIVE_SCOPE_PROOF");
    const worker = (await request("/api/host/tasks")).body.workers.find(
      (row) => row.agentId === a.id,
    );
    const target = {
      agentId: a.id,
      generation: worker.generation,
      conversationId: worker.data.conversations[0].id,
    };
    const input = {
      ...target,
      command: "subagent.spawn",
      prompt: "read recovery",
      name: "恢复子代理",
      requestId: "recover-owned",
      config: { tools: ["owned_probe"] },
    };
    const started = await request("/api/host/tasks/command", input);
    assert.equal(started.status, 200);
    const before = await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers
          .find((row) => row.agentId === a.id)
          ?.data?.conversations.some(
            (row) => row.owner?.taskId === started.body.taskId,
          ) && f.requests.length === 1,
    );
    const child = before.workers
      .find((row) => row.agentId === a.id)
      .data.conversations.find(
        (row) => row.owner?.taskId === started.body.taskId,
      );
    await f.reopen();
    const resumed = await until(
      async () => {
        const value = (await request("/api/host/tasks")).body;
        if (
          value.workers.find((row) => row.agentId === a.id)?.status === "failed"
        ) {
          const row = (await f.call("/api/workspace")).agents.find(
            (row) => row.id === a.id,
          );
          assert.fail(`owned 恢复启动失败：${row.error}`);
        }
        return value;
      },
      (value) =>
        value.workers
          .find((row) => row.agentId === a.id)
          ?.data?.conversations.some((row) => row.id === child.id) &&
        f.requests.length >= 2,
    );
    assert.equal(
      resumed.workers
        .find((row) => row.agentId === a.id)
        .data.conversations.filter(
          (row) => row.owner?.taskId === started.body.taskId,
        ).length,
      1,
      "恢复不复制子会话",
    );
    assert.equal(
      (await request("/api/host/tasks/command", input)).body.taskId,
      started.body.taskId,
    );
    gate.resolve();
    await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers.find((row) => row.agentId === a.id)?.data?.tasks
          .length === 0,
    );
    const detail = await request(
      "/api/host/tasks/detail?" +
        new URLSearchParams({ ...target, taskId: started.body.taskId }),
    );
    assert.equal(detail.body.task.outcome.status, "completed");
    assert.match(
      detail.body.task.outcome.result.answer,
      /OWNED_NATIVE_SCOPE_PROOF/,
      "工具必须绑定到子代理自身 scope，不能复用父会话工具闭包",
    );
    assert.equal(
      detail.body.children[0].messages.filter((row) => row.role === "user")
        .length,
      1,
      "同一 submission 在恢复后只准入一次",
    );
    assert.equal(
      detail.body.children[0].messages.filter(
        (row) => row.role === "toolResult",
      ).length,
      1,
    );
    assert.equal(
      f.requests.length,
      3,
      "被中断的生成重发一次，原生工具结果只触发一次后续生成",
    );
  },
);

test(
  "单个真实 worker 暂停时 Host 监控有界失败，其他 worker 的状态仍可见",
  { timeout: 30000 },
  async (t) => {
    const { f, a, b, request } = await setup(t);
    const pid = (await f.call("/api/workspace")).agents.find(
      (row) => row.id === b.id,
    ).pid;
    process.kill(pid, "SIGSTOP");
    try {
      const value = await request("/api/host/tasks");
      assert.equal(value.status, 200);
      assert.equal(value.body.partial, true);
      assert.equal(
        value.body.workers.find((row) => row.agentId === a.id).data.supported,
        true,
      );
      const blocked = value.body.workers.find((row) => row.agentId === b.id);
      assert.match(blocked.error, /读取超时/);
      assert.equal(blocked.data, null, "未知状态不能伪装成空任务成功");
    } finally {
      process.kill(pid, "SIGCONT");
    }
    await until(
      async () => (await request("/api/host/tasks")).body,
      (value) =>
        value.workers.find((row) => row.agentId === b.id)?.data?.supported ===
        true,
    );
  },
);

test(
  "原生子代理模型失败保存 failed 回执，不把任务图清空当作成功",
  { timeout: 30000 },
  async (t) => {
    const { f, a, request } = await setup(t, {
      modelReply: () => ({
        error: { status: 400, message: "受控本地模型失败" },
      }),
    });
    const worker = (await request("/api/host/tasks")).body.workers.find(
      (row) => row.agentId === a.id,
    );
    const target = {
      agentId: a.id,
      generation: worker.generation,
      conversationId: worker.data.conversations[0].id,
    };
    const launch = await request("/api/host/tasks/command", {
      ...target,
      command: "subagent.spawn",
      prompt: "must fail natively",
      requestId: "native-failure",
    });
    assert.equal(launch.status, 200);
    const detail = await until(
      async () =>
        (
          await request(
            "/api/host/tasks/detail?" +
              new URLSearchParams({ ...target, taskId: launch.body.taskId }),
          )
        ).body,
      (value) => value.task?.status === "terminal",
    );
    assert.equal(
      detail.task.outcome.status,
      "failed",
      "unanswered 不是完成回执",
    );
    assert.match(detail.task.outcome.error.message, /子代理未完成/);
    assert.equal(detail.task.outcome.result.status, "unanswered");
    const waited = await request("/api/host/tasks/command", {
      ...target,
      command: "wait",
      taskId: launch.body.taskId,
    });
    assert.equal(waited.status, 200);
    assert.deepEqual(waited.body.task, detail.task, "等待保留原生失败回执");
    assert.equal(waited.body.task.outcome.status, "failed");
    assert.equal(f.requests.length, 1);
  },
);
