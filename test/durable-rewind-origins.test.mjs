import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { loadPiSessionManager } from "../src/agent/pi-sdk.mjs";

// 经真实 worker 与原生树退回；仅在 workspace 里拼消息无法验证 Pi 的活跃路径。
async function rewoundFixture(t) {
  const f = await desktopFixture({ noExtensions: true });
  t.after(() => f.close());
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "反复退回",
  });
  const prefix = `/agents/${actor.id}`;
  const source = (await f.call(`${prefix}/api/state`)).sessionId;
  const state = (id = source) => f.call(`${prefix}/api/state?sessionId=${id}`);
  const command = (id, input) =>
    f.call(`${prefix}/api/command?sessionId=${id}`, {
      id: Number(id),
      sessionId: String(id),
      ...input,
    });
  const turn = async (id, message) => {
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      message,
      sessionId: String(id),
    });
    return until(
      () => state(id),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === `answer: ${message}`),
    );
  };
  await turn(source, "Q1");
  await turn(source, "Q2");
  const third = await turn(source, "Q3");
  const origins = new Map(third.messages.map((row) => [row.text, row.entryId]));
  await command(source, { command: "rewind", entryId: origins.get("Q2") });
  const fourth = await turn(source, "Q4");
  for (const row of fourth.messages.filter(
    (row) => row.text === "Q4" || row.text === "answer: Q4",
  ))
    origins.set(row.text, row.entryId);
  const rewind = await command(source, {
    command: "rewind",
    entryId: origins.get("Q4"),
  });
  return { f, actor, prefix, source, state, command, turn, origins, rewind };
}

test(
  "连续退回保留每条可见消息的原始 entry，并保持 Pi parent/leaf 的活跃路径",
  { timeout: 60000 },
  async (t) => {
    const { f, actor, prefix, source, state, origins, rewind } =
      await rewoundFixture(t);
    const expected = ["Q1", "answer: Q1", "Q2", "Q4"];
    const assertOrigins = (current) => {
      assert.deepEqual(
        current.messages.map((row) => row.text),
        expected,
      );
      for (const row of current.messages) {
        assert.equal(
          row.entryId,
          origins.get(row.text),
          `${row.text} 仍指向原始条目`,
        );
        assert.notEqual(
          row.entryId,
          rewind.entryId,
          "不能把全部前缀折叠到退回标记",
        );
      }
    };
    assertOrigins(await state());
    const tree = await f.call(`${prefix}/api/tree?id=${source}`);
    assert.equal(tree.native.leafId, tree.leaf);
    assert.deepEqual(
      tree.native.nodes
        .filter((row) => row.active && row.type === "message")
        .map((row) => row.preview),
      expected,
    );
    const byId = new Map(tree.native.nodes.map((row) => [row.id, row]));
    const chain = new Set();
    for (let node = byId.get(tree.leaf); node; node = byId.get(node.parentId))
      chain.add(node.id);
    assert.deepEqual(
      chain,
      new Set(
        tree.native.nodes.filter((row) => row.active).map((row) => row.id),
      ),
    );
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === actor.id)?.status === "running",
    );
    assertOrigins(await state());
  },
);

test(
  "两次退回后从界面可见的 Q1 分叉只继承 Q1，不把 Q2/Q4 发给模型",
  { timeout: 60000 },
  async (t) => {
    const { f, actor, source, state, command } = await rewoundFixture(t);
    const before = await state();
    const visibleQ1 = before.messages.find((row) => row.text === "Q1");
    const fork = await command(source, {
      command: "fork",
      entryId: visibleQ1.entryId,
    });
    const forkState = () =>
      f.call(`/agents/${fork.agentId}/api/state?sessionId=${fork.sessionId}`);
    const branch = await forkState();
    assert.deepEqual(
      branch.messages.map((row) => row.text),
      ["Q1"],
    );
    assert.equal(branch.stats.tokens.total, 0);
    assert.deepEqual((await state()).messages, before.messages);
    assert.deepEqual((await state()).stats, before.stats);
    const tree = await f.call(
      `/agents/${fork.agentId}/api/tree?id=${fork.sessionId}`,
    );
    assert.equal(tree.forkOf, null);
    const createdFrom = (await f.call("/api/workspace")).agents.find(
      (row) => row.id === fork.agentId,
    ).createdFrom;
    assert.equal(createdFrom.agentId, actor.id);
    assert.equal(createdFrom.conversationId, Number(source));
    assert.equal(createdFrom.entryId, visibleQ1.entryId);
    await f.call(
      `/agents/${fork.agentId}/api/prompt?sessionId=${fork.sessionId}`,
      {
        sessionId: fork.sessionId,
        message: "verify fork",
      },
    );
    await until(
      forkState,
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === "answer: verify fork"),
    );
    const sent = f.requests
      .at(-1)
      .messages.filter((row) => row.role !== "system");
    assert.deepEqual(
      sent.map((row) => row.content),
      ["Q1", "verify fork"],
    );
    assert.equal(f.requests.length, 5, "退回与分叉都不重放模型请求");
  },
);

test(
  "压缩过的原生会话退回后，可见消息原点对齐且续跑仍使用 Pi 的摘要与保留区",
  { timeout: 60000 },
  async (t) => {
    const f = await desktopFixture({ noExtensions: true });
    t.after(() => f.close());
    const { SessionManager } = await loadPiSessionManager();
    const native = SessionManager.create(
      f.cwd,
      await nativeSessionDirectory(f.cwd, f.agentDir),
    );
    native.appendModelChange("desktop-fixture", "local");
    native.appendThinkingLevelChange("off");
    const user = (content) =>
      native.appendMessage({ role: "user", content, timestamp: Date.now() });
    const answer = (text) =>
      native.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "openai-completions",
        provider: "desktop-fixture",
        model: "local",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    user("omitted Q1");
    answer("omitted A1");
    const kept = user("kept Q2");
    answer("kept A2");
    native.appendCompaction("native summary", kept, 0);
    user("target Q3");
    answer("abandoned A3");
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    );
    const actor = catalog.agents.find((row) => row.source === "pi");
    await f.command("agent.resume", { id: actor.id });
    const prefix = `/agents/${actor.id}`;
    const state = () => f.call(`${prefix}/api/state`);
    const before = await state();
    const point = before.messages.find(
      (row) => row.text === "target Q3",
    ).entryId;
    await f.call(`${prefix}/api/command?sessionId=${before.sessionId}`, {
      command: "rewind",
      id: Number(before.sessionId),
      sessionId: before.sessionId,
      entryId: point,
    });
    const current = await state();
    assert.deepEqual(
      current.messages.map((row) => row.text),
      ["kept Q2", "kept A2", "target Q3"],
    );
    for (const row of current.messages)
      assert.equal(
        row.entryId,
        before.messages.find((prior) => prior.text === row.text).entryId,
      );
    await f.call(`${prefix}/api/prompt?sessionId=${before.sessionId}`, {
      sessionId: before.sessionId,
      message: "after rewind",
    });
    await until(
      state,
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === "answer: after rewind"),
    );
    const sent = JSON.stringify(f.requests.at(-1).messages);
    assert.ok(sent.includes("native summary"));
    assert.ok(sent.includes("kept Q2"));
    assert.equal(sent.includes("omitted Q1"), false);
    assert.equal(sent.includes("abandoned A3"), false);
  },
);
