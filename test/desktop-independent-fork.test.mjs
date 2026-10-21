import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { desktopFixture, until } from "./desktop-fixture.mjs";

const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function send(fixture, actor, message) {
  const prefix = `/agents/${actor.id}`;
  const session = (await fixture.call(prefix + "/api/state")).sessionId;
  await fixture.call(prefix + `/api/prompt?sessionId=${session}`, {
    sessionId: session,
    message,
  });
  return until(
    () => fixture.call(prefix + `/api/state?sessionId=${session}`),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === `answer: ${message}`),
  );
}

test("默认 Host 创建独立同级会话，继承历史而不在源 worker 增加分支", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "来源",
    });
    const before = await send(fixture, source, "SOURCE_INDEPENDENT_Q");
    const metadata = await fixture.call(
      `/api/workspace/detail?kind=agent&id=${source.id}`,
    );
    const sourceDigest = await digest(metadata.nativeSessionPath);
    const created = await fixture.command("conversation.fork", {
      id: source.id,
      generation: 0,
      conversationId: Number(before.sessionId),
    });
    assert.equal(
      typeof created.agentId,
      "string",
      "新分支必须返回新的 Desktop Agent 身份",
    );
    assert.notEqual(created.agentId, source.id);
    const catalog = await fixture.call("/api/workspace");
    const parent = catalog.agents.find((row) => row.id === source.id);
    const child = catalog.agents.find((row) => row.id === created.agentId);
    assert.ok(child);
    assert.equal(child.projectId, parent.projectId);
    assert.notEqual(child.pid, parent.pid);
    assert.notEqual(child.nativeSessionId, parent.nativeSessionId);
    assert.notEqual(child.nativeSessionPath, parent.nativeSessionPath);
    assert.equal(parent.branches.length, 0);
    assert.equal(child.branches.length, 0);
    const inherited = await fixture.call(`/agents/${child.id}/api/state`);
    assert.ok(
      inherited.messages.some((row) => row.text === "SOURCE_INDEPENDENT_Q"),
    );
    assert.deepEqual(
      inherited.messages
        .filter((row) => row.role === "user")
        .map((row) => row.text),
      ["SOURCE_INDEPENDENT_Q"],
    );
    await send(fixture, child, "INDEPENDENT_ONLY_Q");
    assert.ok(
      fixture.requests
        .at(-1)
        .messages.some((row) => row.content === "SOURCE_INDEPENDENT_Q"),
    );
    const unchanged = await fixture.call(`/agents/${source.id}/api/state`);
    assert.deepEqual(unchanged.messages, before.messages);
    assert.equal(await digest(metadata.nativeSessionPath), sourceDigest);
    await fixture.command("agent.stop", { id: source.id });
    await send(fixture, child, "SOURCE_STOPPED_CHILD_ALIVE");
    await fixture.reopen();
    await until(
      () => fixture.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === child.id)?.status === "running",
    );
    assert.ok(
      (await fixture.call(`/agents/${child.id}/api/state`)).messages.some(
        (row) => row.text === "SOURCE_STOPPED_CHILD_ALIVE",
      ),
    );
  } finally {
    await fixture.close();
  }
});

test("工作台使用的 worker URL 分支命令也经默认 Host 创建独立会话", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "工作台来源",
    });
    const state = await send(fixture, source, "WORKBENCH_FORK_SOURCE");
    const created = await fixture.call(
      `/agents/${source.id}/api/command?generation=0&sessionId=${state.sessionId}`,
      {
        command: "fork",
        id: Number(state.sessionId),
        sessionId: state.sessionId,
        mode: "tail",
        expectedEntryId: state.messages.at(-1).entryId,
      },
    );
    assert.equal(
      typeof created.agentId,
      "string",
      "不能绕过 Host 创建族内分支",
    );
    const catalog = await fixture.call("/api/workspace");
    assert.ok(catalog.agents.some((row) => row.id === created.agentId));
    assert.equal(
      catalog.agents.find((row) => row.id === source.id).branches.length,
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("过期创建检查点不留下空白会话，也不破坏来源的同步和后续工作", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "检查点来源",
    });
    const state = await send(fixture, source, "CHECKPOINT_SOURCE");
    const before = (await fixture.call("/api/workspace")).agents.length;
    await assert.rejects(
      fixture.command("conversation.fork", {
        id: source.id,
        generation: 0,
        conversationId: Number(state.sessionId),
        expectedEntryId: state.messages.at(-1).entryId + 1,
      }),
      (error) => error.status === 409,
    );
    assert.equal((await fixture.call("/api/workspace")).agents.length, before);
    await send(fixture, source, "SOURCE_AFTER_REJECTED_FORK");
  } finally {
    await fixture.close();
  }
});

test("初始化回执丢失后重试启动接管已发布的同一快照，而非空会话或更新的来源", async () => {
  const { createServer } = await import("node:http");
  const { launchService } = await import("../src/control-plane/process.mjs");
  let loseReceipt = true;
  const fixture = await desktopFixture({
    noExtensions: true,
    launch(entry, options) {
      const service = launchService(entry, options);
      let proxy;
      const ready = service.ready.then(async (value) => {
        proxy = createServer(async (request, response) => {
          try {
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const origin = new URL(value.url).origin;
            const upstream = await fetch(new URL(request.url, origin), {
              method: request.method,
              headers: { Origin: origin, "Content-Type": "application/json" },
              ...(request.method === "POST"
                ? { body: Buffer.concat(chunks) }
                : {}),
            });
            const bytes = Buffer.from(await upstream.arrayBuffer());
            if (loseReceipt && request.url.startsWith("/api/fork-source")) {
              loseReceipt = false;
              response.writeHead(503, { "Content-Type": "application/json" });
              response.end(
                JSON.stringify({ error: "测试传输未确认初始化回执" }),
              );
            } else {
              response.writeHead(upstream.status, {
                "Content-Type": "application/json",
              });
              response.end(bytes);
            }
          } catch (error) {
            response.writeHead(502);
            response.end(JSON.stringify({ error: error.message }));
          }
        });
        await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
        return { ...value, url: `http://127.0.0.1:${proxy.address().port}/` };
      });
      return {
        ...service,
        ready,
        async stop() {
          await service.stop();
          if (proxy?.listening) {
            proxy.closeAllConnections();
            await new Promise((resolve) => proxy.close(resolve));
          }
        },
      };
    },
  });
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "不确定回执来源",
    });
    const state = await send(fixture, source, "FROZEN_BEFORE_LOSS");
    await assert.rejects(
      fixture.command("conversation.fork", {
        id: source.id,
        generation: 0,
        conversationId: Number(state.sessionId),
      }),
      (error) => error.status === 503,
    );
    const reserved = (await fixture.call("/api/workspace")).agents.find(
      (row) => row.id !== source.id,
    );
    assert.equal(reserved.nativeInitializationPending, true);
    await send(fixture, source, "SOURCE_AFTER_LOST_RECEIPT");
    await fixture.command("agent.start", { id: reserved.id });
    const restored = await fixture.call(`/agents/${reserved.id}/api/state`);
    assert.ok(
      restored.messages.some((row) => row.text === "FROZEN_BEFORE_LOSS"),
    );
    assert.equal(
      restored.messages.some((row) => row.text === "SOURCE_AFTER_LOST_RECEIPT"),
      false,
    );
    assert.equal((await fixture.call("/api/workspace")).agents.length, 2);
  } finally {
    await fixture.close();
  }
});

test("忙时继承已提交工具上下文，但不复制在途任务或 owned 子代理", async (t) => {
  const { subagentToolFixture } = await import("./subagent-tool-fixture.mjs");
  const gate = Promise.withResolvers();
  const { f, actor, prefix, parent, invoke } = await subagentToolFixture(t, {
    beforeModelResponse: async (input) => {
      if (input.messages.at(-1)?.content === "HELD_SOURCE_CHILD")
        await gate.promise;
    },
    release: () => gate.resolve(),
  });
  const spawned = await invoke({
    action: "spawn",
    prompt: "HELD_SOURCE_CHILD",
    name: "来源在途子代理",
  });
  const waiting = invoke({ action: "wait", taskId: spawned.taskId });
  void waiting.catch(() => {});
  try {
    await until(
      () => f.call(`${prefix}/api/state?sessionId=${parent}`),
      (value) =>
        !value.idle &&
        value.activeCalls.some((call) => call.name === "desk_subagent"),
    );
    const created = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
      conversationId: Number(parent),
    });
    const childPrefix = `/agents/${created.agentId}`;
    const inherited = await f.call(childPrefix + "/api/state");
    assert.equal(inherited.idle, true);
    const graph = await f.call(
      `${childPrefix}/api/tasks?sessionId=${created.sessionId}`,
    );
    assert.deepEqual(graph.tasks, []);
    assert.deepEqual(graph.conversations, []);
    await f.call(`${childPrefix}/api/prompt?sessionId=${created.sessionId}`, {
      sessionId: created.sessionId,
      message: "CLONE_WITHOUT_SOURCE_WORK",
    });
    await until(
      () => f.call(childPrefix + "/api/state"),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === "NATIVE_TOOL_DONE"),
    );
    const request = f.requests.findLast(
      (input) => input.messages.at(-1)?.content === "CLONE_WITHOUT_SOURCE_WORK",
    );
    assert.ok(request);
    const pending = new Set();
    for (const message of request.messages) {
      if (message.role === "user")
        assert.equal(
          pending.size,
          0,
          "公开 provider 应得到完整配对的工具上下文",
        );
      for (const call of message.tool_calls ?? []) pending.add(call.id);
      if (message.role === "tool") pending.delete(message.tool_call_id);
    }
    const stillRunning = await f.call(
      `${prefix}/api/tasks?sessionId=${parent}`,
    );
    assert.ok(stillRunning.tasks.some((task) => task.id === spawned.taskId));
    assert.equal(
      (
        await f.call(
          `${childPrefix}/api/subagent-history?sessionId=${created.sessionId}`,
        )
      ).records.length,
      0,
    );
  } finally {
    gate.resolve();
    await waiting;
  }
});

test("精确历史位置保留上下文能力，并继承创建时配置和正常人格审批绑定", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "配置来源",
    });
    const first = await send(fixture, source, "CONFIG_HISTORY_A");
    const point = first.messages.find(
      (row) => row.text === "answer: CONFIG_HISTORY_A",
    ).entryId;
    await send(fixture, source, "CONFIG_HISTORY_B");
    const persona = await fixture.command("prompt.save", {
      name: "继承人格",
      instructions: "INHERITED_PERSONALITY_RULE",
    });
    await fixture.command("agent.prompt", {
      id: source.id,
      promptProfileId: persona.id,
    });
    await fixture.command("agent.policy", { id: source.id, mode: "ask-all" });
    const active = (await fixture.call(`/agents/${source.id}/api/agent`))
      .active;
    await fixture.call(
      `/agents/${source.id}/api/command?sessionId=${active.id}`,
      {
        command: "configure",
        id: active.id,
        sessionId: String(active.id),
        revision: active.revision,
        tools: ["read"],
        nativeDefaults: false,
        thinkingLevel: "off",
      },
    );
    const created = await fixture.command("conversation.fork", {
      id: source.id,
      generation: 0,
      conversationId: active.id,
      entryId: point,
    });
    const child = (await fixture.call("/api/workspace")).agents.find(
      (row) => row.id === created.agentId,
    );
    assert.equal(child.promptProfileId, persona.id);
    assert.equal(child.approvalMode, "ask-all");
    let profile = (await fixture.call(`/agents/${child.id}/api/agent`)).active;
    assert.deepEqual(profile.tools, ["read"]);
    assert.equal(profile.instructions, "INHERITED_PERSONALITY_RULE");
    assert.equal(profile.thinkingLevel, "off");
    await send(fixture, child, "AFTER_EXACT_CONFIG_FORK");
    const request = fixture.requests.at(-1);
    assert.ok(
      JSON.stringify(request.messages).includes("INHERITED_PERSONALITY_RULE"),
    );
    assert.ok(
      request.messages.some((row) => row.content === "CONFIG_HISTORY_A"),
    );
    assert.equal(
      request.messages.some((row) => row.content === "CONFIG_HISTORY_B"),
      false,
    );
    await fixture.reopen();
    await until(
      () => fixture.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === child.id)?.status === "running",
    );
    profile = (await fixture.call(`/agents/${child.id}/api/agent`)).active;
    assert.deepEqual(profile.tools, ["read"]);
    assert.equal(profile.instructions, "INHERITED_PERSONALITY_RULE");
  } finally {
    await fixture.close();
  }
});

test("空来源可以创建独立会话，首次发言前的本地配置在重启后不被继承快照覆盖", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "空来源",
    });
    const created = await fixture.command("conversation.fork", {
      id: source.id,
      generation: 0,
    });
    const prefix = `/agents/${created.agentId}`;
    const active = (await fixture.call(prefix + "/api/agent")).active;
    assert.deepEqual((await fixture.call(prefix + "/api/state")).messages, []);
    await fixture.call(`${prefix}/api/command?sessionId=${active.id}`, {
      command: "configure",
      id: active.id,
      sessionId: String(active.id),
      revision: active.revision,
      tools: [],
      nativeDefaults: false,
    });
    await fixture.reopen();
    await until(
      () => fixture.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === created.agentId)?.status ===
        "running",
    );
    assert.deepEqual(
      (await fixture.call(prefix + "/api/agent")).active.tools,
      [],
    );
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test("继承的原生扩展状态在新会话首次工具执行前恢复到自己的资源 Session", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const fixture = await desktopFixture({
    modelReply: async (input) => {
      if (input.messages.at(-1)?.content === "CLONE_READ_RUNTIME_STATE")
        return {
          toolCalls: [
            {
              id: "clone-state-read",
              type: "function",
              function: { name: "fixture_read_state", arguments: "{}" },
            },
          ],
        };
      return { text: "STATE_TOOL_DONE" };
    },
  });
  try {
    const extension = join(fixture.root, "native-state.mjs");
    await writeFile(
      extension,
      `export default function(pi){
      pi.on("session_start",async(_event,ctx)=>{const prior=ctx.sessionManager.getEntries().findLast(e=>e.customType==="fixture-start-count")?.data?.count??0;pi.appendEntry("fixture-start-count",{count:prior+1});});
       pi.registerCommand("set-fixture-state",{handler:async(args)=>{pi.appendEntry("fixture-state",{value:args});}});
      pi.registerTool({name:"fixture_read_state",label:"State",description:"Read fixture state",parameters:{type:"object",properties:{}},annotations:{readOnlyHint:true},execute:async(_id,_args,_signal,_update,ctx)=>({content:[{type:"text",text:(ctx.sessionManager.getEntries().findLast(e=>e.customType==="fixture-state")?.data?.value??"MISSING_STATE")+":"+(ctx.sessionManager.getEntries().findLast(e=>e.customType==="fixture-start-count")?.data?.count)}],details:{}})});
    }`,
    );
    const settings = join(fixture.agentDir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        ...JSON.parse(await readFile(settings, "utf8")),
        extensions: [extension],
      }),
    );
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const source = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "资源状态来源",
    });
    const active = (await fixture.call(`/agents/${source.id}/api/agent`))
      .active;
    assert.ok(
      active.tools.includes("fixture_read_state"),
      "夹具必须通过原生 SDK 注册工具",
    );
    await fixture.call(
      `/agents/${source.id}/api/prompt?sessionId=${active.id}`,
      {
        sessionId: String(active.id),
        message: "/set-fixture-state INHERITED_RUNTIME_STATE",
      },
    );
    const created = await fixture.command("conversation.fork", {
      id: source.id,
      generation: 0,
    });
    const prefix = `/agents/${created.agentId}`;
    await fixture.call(`${prefix}/api/prompt?sessionId=${created.sessionId}`, {
      sessionId: created.sessionId,
      message: "CLONE_READ_RUNTIME_STATE",
    });
    const state = await until(
      () => fixture.call(prefix + "/api/state"),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.toolCallId === "clone-state-read"),
    );
    assert.equal(
      state.messages.find((row) => row.toolCallId === "clone-state-read").text,
      "INHERITED_RUNTIME_STATE:2",
    );
  } finally {
    await fixture.close();
  }
});

test("末尾 context edit 的创建保留原始记录，但不把已省略内容带回模型上下文", async () => {
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const { loadPiSessionManager } = await import("../src/agent/pi-sdk.mjs");
  const { nativeSessionDirectory } = await import(
    "../src/session/pi-session-storage.mjs"
  );
  const fixture = await desktopFixture({ noExtensions: true });
  try {
    const { SessionManager } = await loadPiSessionManager();
    const native = SessionManager.create(
      fixture.cwd,
      await nativeSessionDirectory(fixture.cwd, fixture.agentDir),
    );
    native.appendModelChange("desktop-fixture", "local");
    native.appendMessage({
      role: "user",
      content: [{ type: "text", text: "VISIBLE_LAST_USER" }],
      timestamp: Date.now(),
    });
    const answer = native.appendMessage({
      ...fauxAssistantMessage("OMITTED_LAST_ANSWER"),
      provider: "desktop-fixture",
      model: "local",
      api: "openai-completions",
    });
    native.appendContextEdit(answer, null);
    const catalog = await until(
      () => fixture.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.nativeSessionId === native.getSessionId(),
        ),
    );
    const source = catalog.agents.find(
      (row) => row.nativeSessionId === native.getSessionId(),
    );
    await fixture.command("agent.resume", { id: source.id });
    const tree = await fixture.call(`/agents/${source.id}/api/tree`);
    const created = await fixture.command("conversation.fork", {
      id: source.id,
      generation: 1,
      expectedEntryId: tree.currentEntryId,
    });
    const state = await fixture.call(`/agents/${created.agentId}/api/state`);
    assert.ok(state.messages.some((row) => row.text === "OMITTED_LAST_ANSWER"));
    await send(fixture, { id: created.agentId }, "AFTER_OMITTED_ANSWER");
    const context = JSON.stringify(fixture.requests.at(-1).messages);
    assert.ok(context.includes("VISIBLE_LAST_USER"));
    assert.equal(context.includes("OMITTED_LAST_ANSWER"), false);
  } finally {
    await fixture.close();
  }
});
