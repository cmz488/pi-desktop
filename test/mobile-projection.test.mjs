import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import {
  deriveView,
  emptyTranscript,
  toTranscript,
  toUiMessage,
} from "../src/server/mobile-projection.mjs";

/**
 * 手机端实时投影。
 *
 * 投影是纯函数（形状与空值语义），接线上有三件事必须成立：
 *   1. 快照带 view + transcript，手机端首屏有内容；
 *   2. SSE 用 Percho 的命名事件（list／view／ping），不是裸 message；
 *   3. 写操作后推一次 view，手机端不必轮询。
 */
test("deriveView 给出 Percho 视图所需的全部字段", () => {
  const view = deriveView(
    {
      id: 7,
      name: "会话",
      cwd: "/p",
      status: "running",
      updatedAt: 1700000000000,
      stats: { tokens: { input: 11, output: 22 }, cost: 0.5 },
    },
    {
      idle: false,
      partial: { text: "正在输出" },
      activeCalls: [{ name: "bash", status: "running" }],
      compactions: [],
      queued: 2,
    },
  );

  assert.equal(view.sessionId, "7");
  assert.equal(view.name, "会话");
  assert.equal(view.cwd, "/p");
  assert.equal(view.agentActive, true);
  assert.equal(view.compacting, false);
  assert.equal(view.queued, true);
  assert.equal(view.currentTool, "bash");
  assert.equal(view.assistantTail, "正在输出");
  assert.deepEqual(view.todos, []);
  assert.equal(view.pendingPermission, null);
  assert.equal(view.lastError, null);
  assert.deepEqual(view.stats, { inputTokens: 11, outputTokens: 22, cost: 0.5 });
  assert.equal(view.lastActivity, 1700000000000);
});

test("deriveView 在缺字段时给出类型允许的空值，而不是省略键", () => {
  const view = deriveView({ id: 1 }, undefined);
  for (const key of [
    "sessionId",
    "name",
    "cwd",
    "agentActive",
    "compacting",
    "queued",
    "currentTool",
    "assistantTail",
    "todos",
    "pendingPermission",
    "lastError",
    "stats",
    "lastActivity",
  ])
    assert.ok(key in view, `${key} 必须存在（手机端按字段存在性分支）`);
  assert.equal(view.currentTool, null, "没有工具在跑必须是 null");
  assert.equal(view.lastError, null, "没有错误必须是 null");
  assert.equal(view.stats, null);
});

test("toUiMessage 只映射手机端渲染的 kind，未知角色落 system", () => {
  assert.equal(toUiMessage({ role: "user", text: "hi" }, 0).kind, "user");
  assert.equal(toUiMessage({ role: "assistant", text: "yo" }, 1).kind, "assistant");
  const tool = toUiMessage(
    { role: "toolResult", text: "ok", toolName: "bash", isError: true },
    2,
  );
  assert.equal(tool.kind, "tool");
  assert.equal(tool.toolName, "bash");
  assert.equal(tool.isError, true);
  assert.equal(toUiMessage({ role: "system", text: "s" }, 3).kind, "system");
  // 未知角色不得被误标成 user。
  assert.equal(toUiMessage({ role: "custom", text: "x" }, 4).kind, "system");
});

test("toTranscript 的空闲与流式语义", () => {
  const idle = toTranscript([{ role: "user", text: "q" }]);
  assert.equal(idle.phase, "idle");
  assert.equal(idle.streaming, null);
  assert.equal(idle.agentActive, false);

  const streaming = toTranscript([{ role: "user", text: "q" }], {
    streaming: { id: "s1", text: "abc", thinking: "想" },
  });
  assert.equal(streaming.phase, "streaming");
  assert.equal(streaming.agentActive, true);
  assert.equal(streaming.streaming.text, "abc");
  assert.equal(streaming.streaming.thinking, "想");

  assert.deepEqual(emptyTranscript().messages, []);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-proj-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "proj",
      defaultModel: "local",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const faux = fauxProvider({ provider: "proj", models: [{ id: "local" }], tokensPerSecond: 10000 });
  providers.models.setProvider(faux.provider);
  // fetch（undici）不接受 node:https 的 Agent，所以功能用例走明文端口；
  // TLS 握手本身由 test/mobile.test.mjs 用 https.request 单独验证。
  const app = await startDurableDesk({ cwd, agentDir, directory, providers, port: 0, mobileTls: false });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });

  return { app, faux, directory };
}


const baseUrl = (app) => new URL(app.mobile.url).origin;

test("快照带 view 与 transcript，首屏即有内容", async (t) => {
  const { app, faux } = await fixture(t);
  const token = encodeURIComponent(app.mobile.token);
  const base = baseUrl(app);

  const snapshot = await (await fetch(`${base}/api/snapshot?t=${token}`)).json();
  assert.equal(snapshot.views.length, snapshot.list.length);
  assert.equal(snapshot.transcripts.length, snapshot.list.length);

  const row = snapshot.list[0];
  const view = snapshot.views.find((item) => item.sessionId === row.sessionId);
  assert.ok(view, "每个会话都要有 view");
  assert.equal(typeof view.agentActive, "boolean");

  const transcript = snapshot.transcripts.find((item) => item.sessionId === row.sessionId);
  assert.ok(transcript, "每个会话都要有 transcript");
  assert.ok(Array.isArray(transcript.state.messages));
  assert.equal(transcript.state.phase, "idle");

  // 写一条消息后，transcript 里能看到 user 消息（投影已接入）。
  faux.setResponses([fauxAssistantMessage("ANSWER")]);
  await fetch(`${base}/api/sessions/${row.sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.mobile.token}` },
    body: JSON.stringify({ text: "问题" }),
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const next = await (await fetch(`${base}/api/snapshot?t=${token}`)).json();
    const entry = next.transcripts.find((item) => item.sessionId === row.sessionId);
    if (entry.state.messages.some((message) => message.kind === "assistant" && message.text === "ANSWER"))
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("快照投影没有反映 assistant 回复");
});

test("SSE 使用命名事件帧（list／ping），不是裸 message", async (t) => {
  const { app } = await fixture(t);
  const base = baseUrl(app);
  const token = encodeURIComponent(app.mobile.token);
  const controller = new AbortController();

  const response = await fetch(`${base}/api/stream?t=${token}`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok((response.headers.get("content-type") ?? "").includes("text/event-stream"));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      if (body.includes("event: list") && body.includes("event: ping")) break;
    }
  } finally {
    controller.abort();
  }

  assert.ok(body.includes("event: list"), "必须发命名 list 帧");
  assert.ok(body.includes("event: ping"), "必须发命名 ping 帧");
});
