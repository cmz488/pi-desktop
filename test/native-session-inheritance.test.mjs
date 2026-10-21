import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { loadPiSessionManager } from "../src/agent/pi-sdk.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { launchService } from "../src/control-plane/process.mjs";

/**
 * 公开继承实验：只验证 SDK 文件分叉与正常 worker 初始化能力，不冒充 Host 新分支验收。
 *
 * 接口：cloneWorker 通过公开进程 seam 启动临时 worker，call 仅发送真实 HTTP 请求。
 * 不变量：独立目录、原生身份与 writer；只复制原生记录，不复制执行 journal 或任务。
 * 错误：启动、HTTP 与恢复失败原样抛出；关闭由调用测试统一负责。
 */
const workerEntry = fileURLToPath(
  new URL("../src/control-plane/agent-worker.mjs", import.meta.url),
);
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function cloneWorker(fixture, sourcePath) {
  const { SessionManager } = await loadPiSessionManager();
  const id = randomUUID();
  const manager = SessionManager.forkFrom(
    sourcePath,
    fixture.cwd,
    await nativeSessionDirectory(fixture.cwd, fixture.agentDir),
    { id },
  );
  assert.equal(manager.getSessionId(), id);
  const options = {
    cwd: fixture.cwd,
    readOnly: false,
    agentName: "继承能力夹具",
    approvalMode: "ask-risky",
    agentInstructions: "",
    agentDir: fixture.agentDir,
    directory: join(fixture.root, `independent-${id}`),
    noExtensions: true,
    embeddedUI: true,
    nativeSessionOwner: `${id}:0`,
    nativeSessionPath: manager.getSessionFile(),
  };
  let service = launchService(workerEntry, options);
  return {
    id,
    get pid() {
      return service.child.pid;
    },
    async call(path, input) {
      const ready = await service.ready;
      const origin = new URL(ready.url).origin;
      const response = await fetch(
        origin + path,
        input === undefined
          ? {}
          : {
              method: "POST",
              headers: { Origin: origin, "Content-Type": "application/json" },
              body: JSON.stringify(input),
            },
      );
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    },
    async reopen() {
      await service.stop();
      service = launchService(workerEntry, options);
      await service.ready;
    },
    close: () => service.stop(),
  };
}

async function send(call, sessionId, message) {
  await call(`/api/prompt?sessionId=${sessionId}`, { sessionId, message });
  return until(
    () => call(`/api/state?sessionId=${sessionId}`),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === `answer: ${message}`),
  );
}

test("公开 SDK 分叉由新 worker 接管，继承历史可退回并重启，源记录不变", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  let clone;
  try {
    const project = (await fixture.call("/api/workspace")).projects.find(
      (row) => row.cwd === fixture.cwd,
    );
    const actor = await fixture.command("conversation.create", {
      projectId: project.id,
      name: "继承来源",
    });
    const prefix = `/agents/${actor.id}`;
    const call = (path, input) => fixture.call(prefix + path, input);
    const session = (await call("/api/state")).sessionId;
    await send(call, session, "FORK_SOURCE_A");
    await send(call, session, "FORK_SOURCE_B");
    const source = await fixture.call(
      `/api/workspace/detail?kind=agent&id=${actor.id}`,
    );
    const before = await digest(source.nativeSessionPath);
    const messages = (await call(`/api/state?sessionId=${session}`)).messages;
    clone = await cloneWorker(fixture, source.nativeSessionPath);
    const child = (await clone.call("/api/state")).sessionId;
    assert.notEqual(clone.id, source.nativeSessionId);
    const cloneCall = clone.call.bind(clone);
    await send(cloneCall, child, "FORK_NEW_ONLY");
    assert.ok(
      fixture.requests
        .at(-1)
        .messages.some((row) => row.content === "FORK_SOURCE_B"),
    );
    const tree = await clone.call(`/api/tree?sessionId=${child}`);
    const point = tree.native.nodes.find(
      (row) => row.preview === "answer: FORK_SOURCE_A",
    );
    assert.ok(Number.isSafeInteger(point?.entryId));
    await clone.call(`/api/command?sessionId=${child}`, {
      command: "rewind",
      id: Number(child),
      sessionId: child,
      entryId: point.entryId,
    });
    await send(cloneCall, child, "FORK_AFTER_REWIND");
    const context = fixture.requests.at(-1).messages;
    assert.ok(context.some((row) => row.content === "FORK_SOURCE_A"));
    assert.equal(
      context.some(
        (row) =>
          row.content === "FORK_SOURCE_B" || row.content === "FORK_NEW_ONLY",
      ),
      false,
    );
    await clone.reopen();
    assert.ok(
      (await clone.call("/api/state")).messages.some(
        (row) => row.text === "FORK_AFTER_REWIND",
      ),
    );
    assert.deepEqual(
      (await call(`/api/state?sessionId=${session}`)).messages,
      messages,
    );
    assert.equal(await digest(source.nativeSessionPath), before);
    const catalog = await fixture.call("/api/workspace");
    assert.notEqual(
      clone.pid,
      catalog.agents.find((row) => row.id === actor.id).pid,
    );
  } finally {
    await clone?.close();
    await fixture.close();
  }
});

test("公开 SDK 的压缩、上下文编辑与 custom 贡献在继承后的真实模型请求中保持有效", async () => {
  const fixture = await desktopFixture({ noExtensions: true });
  let clone;
  try {
    const { SessionManager } = await loadPiSessionManager();
    const native = SessionManager.create(
      fixture.cwd,
      await nativeSessionDirectory(fixture.cwd, fixture.agentDir),
    );
    native.appendModelChange("desktop-fixture", "local");
    native.appendThinkingLevelChange("off");
    native.appendMessage({
      role: "user",
      content: [{ type: "text", text: "SOURCE_SUMMARIZED_USER" }],
      timestamp: Date.now(),
    });
    native.appendMessage({
      ...fauxAssistantMessage("SOURCE_SUMMARIZED_ANSWER"),
      provider: "desktop-fixture",
      model: "local",
      api: "openai-completions",
    });
    const kept = native.appendMessage({
      role: "user",
      content: [{ type: "text", text: "SOURCE_RAW_KEPT_USER" }],
      timestamp: Date.now(),
    });
    native.appendMessage({
      ...fauxAssistantMessage("SOURCE_KEPT_ANSWER"),
      provider: "desktop-fixture",
      model: "local",
      api: "openai-completions",
    });
    native.appendCompaction("SOURCE_CANONICAL_SUMMARY", kept, 5000);
    native.appendContextEdit(kept, {
      content: [{ type: "text", text: "SOURCE_EDITED_KEPT_USER" }],
    });
    native.appendCustomMessageEntry(
      "fixture-injection",
      "SOURCE_CUSTOM_CONTEXT",
      false,
    );
    const sourcePath = native.getSessionFile();
    const before = await digest(sourcePath);
    clone = await cloneWorker(fixture, sourcePath);
    const session = (await clone.call("/api/state")).sessionId;
    await send(clone.call.bind(clone), session, "AFTER_CANONICAL_INHERITANCE");
    const context = JSON.stringify(fixture.requests.at(-1).messages);
    for (const text of [
      "SOURCE_CANONICAL_SUMMARY",
      "SOURCE_EDITED_KEPT_USER",
      "SOURCE_KEPT_ANSWER",
      "SOURCE_CUSTOM_CONTEXT",
    ])
      assert.ok(context.includes(text), text);
    for (const text of [
      "SOURCE_SUMMARIZED_USER",
      "SOURCE_SUMMARIZED_ANSWER",
      "SOURCE_RAW_KEPT_USER",
    ])
      assert.equal(context.includes(text), false, text);
    assert.equal(await digest(sourcePath), before);
    assert.equal(
      (await clone.call("/api/agent")).active.model.provider,
      "desktop-fixture",
    );
  } finally {
    await clone?.close();
    await fixture.close();
  }
});
