import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { loadPiSessionManager } from "../src/agent/pi-sdk.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { subagentToolFixture } from "./subagent-tool-fixture.mjs";

const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test(
  "继承的历史任务回执不授管理权，两个 worker 的同号原生任务仍互相隔离",
  { timeout: 60000 },
  async (t) => {
    const sourceGate = Promise.withResolvers(),
      cloneGate = Promise.withResolvers();
    const { f, actor, parent, prefix, invoke } = await subagentToolFixture(t, {
      beforeModelResponse: async (input) => {
        if (input.messages.at(-1)?.content === "SOURCE_COLLISION_CHILD")
          await sourceGate.promise;
        if (input.messages.at(-1)?.content === "CLONE_COLLISION_CHILD")
          await cloneGate.promise;
      },
      release: () => {
        sourceGate.resolve();
        cloneGate.resolve();
      },
    });
    // 正常回合占用 submission／task 等身份，继承只导入 entry；对齐两边真实 ID 分配。
    const SOURCE_PADDING_TURNS = 4;
    for (let index = 0; index < SOURCE_PADDING_TURNS; index++) {
      await f.call(`${prefix}/api/prompt?sessionId=${parent}`, {
        sessionId: parent,
        message: `SOURCE_SEQUENCE_PADDING_${index}`,
      });
      await until(
        () => f.call(`${prefix}/api/state?sessionId=${parent}`),
        (value) => value.idle,
      );
    }
    await invoke({ action: "list" });
    const source = await invoke({
      action: "spawn",
      prompt: "SOURCE_COLLISION_CHILD",
      name: "来源仍在运行",
    });
    const created = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
      conversationId: Number(parent),
    });
    const target = { agentId: created.agentId, sessionId: created.sessionId };
    const clonePrefix = `/agents/${created.agentId}`;
    const inherited = await f.call(
      `${clonePrefix}/api/state?sessionId=${created.sessionId}`,
    );
    assert.ok(
      inherited.messages.some(
        (row) =>
          row.toolName === "desk_subagent" &&
          JSON.parse(row.text).taskId === source.taskId,
      ),
      "必须真实带入旧回执，不能靠删历史避开碰撞",
    );
    await assert.rejects(
      f.call(
        `${clonePrefix}/api/task-detail?sessionId=${created.sessionId}&taskId=${source.taskId}`,
      ),
      (error) => error.status === 404,
    );
    assert.match(
      await invoke(
        { action: "read", taskId: source.taskId },
        { ...target, error: true },
      ),
      /任务不存在/,
    );
    const local = await invoke(
      {
        action: "spawn",
        prompt: "CLONE_COLLISION_CHILD",
        name: "独立会话自己的工作",
      },
      target,
    );
    assert.equal(local.taskId, source.taskId, "夹具必须真的产生同号原生 task");
    const read = await invoke({ action: "read", taskId: local.taskId }, target);
    assert.ok(
      read.children.some((child) =>
        child.messages.some(
          (row) => row.role === "user" && row.text === "CLONE_COLLISION_CHILD",
        ),
      ),
    );
    assert.equal(
      read.children.some((child) =>
        child.messages.some(
          (row) => row.role === "user" && row.text === "SOURCE_COLLISION_CHILD",
        ),
      ),
      false,
    );
    await invoke({ action: "abort", taskId: local.taskId }, target);
    await until(
      () =>
        f.call(
          `${clonePrefix}/api/task-detail?sessionId=${created.sessionId}&taskId=${local.taskId}`,
        ),
      (value) =>
        value.task.status === "terminal" &&
        value.task.outcome.status === "aborted",
    );
    const untouched = await f.call(
      `${prefix}/api/task-detail?sessionId=${parent}&taskId=${source.taskId}`,
    );
    assert.notEqual(
      untouched.task.status,
      "terminal",
      "中止自己的同号任务不能中止来源工作",
    );
    assert.ok(
      untouched.children.some((child) =>
        child.messages.some(
          (row) => row.role === "user" && row.text === "SOURCE_COLLISION_CHILD",
        ),
      ),
    );
  },
);

test("默认 Host 继承 SDK 压缩、context edit 与 custom 的有效上下文，源 JSONL 不变", async () => {
  const f = await desktopFixture({ noExtensions: true });
  try {
    const { SessionManager } = await loadPiSessionManager();
    const native = SessionManager.create(
      f.cwd,
      await nativeSessionDirectory(f.cwd, f.agentDir),
    );
    native.appendModelChange("desktop-fixture", "local");
    native.appendThinkingLevelChange("off");
    native.appendMessage({
      role: "user",
      content: [{ type: "text", text: "HOST_SUMMARIZED_USER" }],
      timestamp: Date.now(),
    });
    native.appendMessage({
      ...fauxAssistantMessage("HOST_SUMMARIZED_ANSWER"),
      provider: "desktop-fixture",
      model: "local",
      api: "openai-completions",
    });
    const kept = native.appendMessage({
      role: "user",
      content: [{ type: "text", text: "HOST_RAW_KEPT_USER" }],
      timestamp: Date.now(),
    });
    native.appendMessage({
      ...fauxAssistantMessage("HOST_KEPT_ANSWER"),
      provider: "desktop-fixture",
      model: "local",
      api: "openai-completions",
    });
    native.appendCompaction("HOST_CANONICAL_SUMMARY", kept, 5000);
    native.appendContextEdit(kept, {
      content: [{ type: "text", text: "HOST_EDITED_KEPT_USER" }],
    });
    native.appendCustomMessageEntry(
      "host-fixture-injection",
      "HOST_CUSTOM_CONTEXT",
      false,
    );
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.nativeSessionId === native.getSessionId(),
        ),
    );
    const source = catalog.agents.find(
      (row) => row.nativeSessionId === native.getSessionId(),
    );
    await f.command("agent.resume", { id: source.id });
    const metadata = await f.call(
      `/api/workspace/detail?kind=agent&id=${source.id}`,
    );
    const before = await digest(metadata.nativeSessionPath);
    const created = await f.command("conversation.fork", {
      id: source.id,
      generation: 1,
    });
    const prefix = `/agents/${created.agentId}`;
    await f.call(`${prefix}/api/prompt?sessionId=${created.sessionId}`, {
      sessionId: created.sessionId,
      message: "AFTER_HOST_CANONICAL_INHERITANCE",
    });
    await until(
      () => f.call(`${prefix}/api/state`),
      (value) =>
        value.idle &&
        value.messages.some(
          (row) => row.text === "answer: AFTER_HOST_CANONICAL_INHERITANCE",
        ),
    );
    const context = JSON.stringify(f.requests.at(-1).messages);
    for (const text of [
      "HOST_CANONICAL_SUMMARY",
      "HOST_EDITED_KEPT_USER",
      "HOST_KEPT_ANSWER",
      "HOST_CUSTOM_CONTEXT",
    ])
      assert.ok(context.includes(text), text);
    for (const text of [
      "HOST_SUMMARIZED_USER",
      "HOST_SUMMARIZED_ANSWER",
      "HOST_RAW_KEPT_USER",
    ])
      assert.equal(context.includes(text), false, text);
    assert.equal(await digest(metadata.nativeSessionPath), before);
  } finally {
    await f.close();
  }
});
