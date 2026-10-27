import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import {
  createAuditLog,
  createBackpressure,
  sanitizeMessage,
  sanitizeTranscript,
  TRANSCRIPT_TAIL_LIMIT,
} from "../src/server/mobile-data.mjs";

/**
 * 手机端出网数据面：脱敏、容量/背压、审计。
 *
 * 桌面端只服务本机回环，没有这些约束；手机端是"不可信客户端"，所以这三项必须可验证：
 *   1. 敏感内容真的不出网（图片 base64、本地路径、会话文件名）；
 *   2. 上限真的生效且可观测（truncated 标记、连接上限、队列上限）；
 *   3. 审计真的记下谁在什么时候做了什么，且不记令牌与正文。
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-data-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "p",
      defaultModel: "m",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const faux = fauxProvider({ provider: "p", models: [{ id: "m" }], tokensPerSecond: 10000 });
  providers.models.setProvider(faux.provider);
  const app = await startDurableDesk({ cwd, agentDir, directory, providers, port: 0, mobileTls: false });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { app, directory, faux };
}

test("脱敏：图片 base64、本地路径、会话文件名都不出网", () => {
  const message = {
    role: "toolResult",
    text: "ok",
    toolName: "bash",
    content: [
      { type: "text", text: "ok" },
      { type: "image", data: "BASE64_SECRET", mimeType: "image/png" },
    ],
    details: {
      paths: ["/home/me/private.txt"],
      sessionFile: "/home/me/.percho/agent/s.jsonl",
      nativeSessionPath: "/home/me/.percho/agent/n.jsonl",
      nested: { artifactPaths: { outputPath: "/tmp/out" }, cwd: "/home/me/project" },
      ok: true,
    },
  };

  const safe = sanitizeMessage(message);
  const text = JSON.stringify(safe);

  assert(!text.includes("BASE64_SECRET"), "图片内容不得出网");
  assert(!text.includes("/home/me"), "本地路径不得出网");
  assert(!text.includes("/tmp/out"), "产物路径不得出网");
  // 字段形状保留（客户端按字段存在与否分支），只是值被清空。
  assert.equal(safe.details.paths.length, 0);
  assert.equal(safe.details.sessionFile, "");
  assert.equal(safe.details.nested.ok, undefined);
  assert.equal(safe.details.ok, true);
  // 图片数量保留，内容清空。
  assert.equal(safe.content[1].type, "image");
  assert.equal(safe.content[1].data, "");
});

test("脱敏：尾部上限与 truncated 标记如实反映", () => {
  const many = Array.from({ length: TRANSCRIPT_TAIL_LIMIT + 5 }, (_value, index) => ({
    role: "user",
    text: `m${index}`,
  }));
  const { messages, truncated } = sanitizeTranscript(many);
  assert.equal(messages.length, TRANSCRIPT_TAIL_LIMIT);
  assert.equal(truncated, true);
  assert.equal(messages[0].text, "m5", "保留的是尾部");

  const few = sanitizeTranscript([{ role: "user", text: "only" }]);
  assert.equal(few.truncated, false);
});

test("背压：连接上限与队列上限都明确拒绝", () => {
  const bp = createBackpressure({ maxClients: 2, maxQueue: 3, maxPendingEventsPerSession: 2 });
  assert.equal(bp.admit(), true);
  assert.equal(bp.admit(), true);
  assert.equal(bp.admit(), false, "超过连接上限必须拒绝");
  bp.release();
  assert.equal(bp.clients, 1);
  bp.release();
  assert.equal(bp.clients, 0);

  assert.equal(bp.enqueue("a", 1), true);
  assert.equal(bp.enqueue("a", 2), true);
  assert.equal(bp.enqueue("a", 3), false, "单会话队列上限必须拒绝");
  assert.deepEqual(bp.drain("a"), [1, 2]);
  assert.equal(bp.queueSize, 0);
});

test("审计：记录 IP/动作/目标/结果，绝不记令牌与正文", () => {
  const audit = createAuditLog();
  audit.record({ ip: "192.168.1.9", action: "prompt", target: "7", result: "ok" });
  audit.record({ ip: "192.168.1.9", action: "abort", target: "7", result: "ok" });

  assert.equal(audit.size, 2);
  const entry = audit.entries[0];
  assert.equal(entry.ip, "192.168.1.9");
  assert.equal(entry.action, "prompt");
  assert.equal(entry.target, "7");
  assert.equal(entry.result, "ok");
  assert.match(entry.t, /^\d{4}-\d{2}-\d{2}T/, "必须有 ISO 时间");

  const text = JSON.stringify(audit.entries);
  assert(!/token/i.test(text), "审计不得包含令牌字段");
  assert(!text.includes("本会话不该出现的正文"));
});

test("真实 Host：写操作产生审计记录，且不含令牌与正文", async (t) => {
  const { app, directory, faux } = await fixture(t);
  const base = new URL(app.mobile.url).origin;
  const token = encodeURIComponent(app.mobile.token);

  const snapshot = await (await fetch(`${base}/api/snapshot?t=${token}`)).json();
  const id = snapshot.list[0].sessionId;

  faux.setResponses([fauxAssistantMessage("OK")]);
  const secret = "正文不该进审计-ABC123";
  const written = await fetch(`${base}/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${app.mobile.token}`,
    },
    body: JSON.stringify({ text: secret }),
  });
  assert.equal(written.status, 200);

  // 审计落盘（异步追加，给一点时间）。
  let auditText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    auditText = await readFile(join(directory, "mobile-audit.jsonl"), "utf8").catch(() => "");
    if (auditText.includes('"prompt"')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(auditText, /"action":"prompt"/, "必须记录写操作");
  assert.match(auditText, /"result":"ok"/);
  assert(!auditText.includes(app.mobile.token), "审计不得含令牌");
  assert(!auditText.includes(secret), "审计不得含正文");
});

test("真实 Host：远程控制关闭时写操作记 denied 审计", async (t) => {
  const { app, directory } = await fixture(t);
  const origin = new URL(app.url).origin;
  await fetch(`${origin}/api/lan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ remoteControl: false }),
  });

  const base = new URL(app.mobile.url).origin;
  const token = encodeURIComponent(app.mobile.token);
  const snapshot = await (await fetch(`${base}/api/snapshot?t=${token}`)).json();
  const id = snapshot.list[0].sessionId;

  const denied = await fetch(`${base}/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${app.mobile.token}`,
    },
    body: JSON.stringify({ text: "x" }),
  });
  assert.equal(denied.status, 403);

  let auditText = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    auditText = await readFile(join(directory, "mobile-audit.jsonl"), "utf8").catch(() => "");
    if (auditText.includes("remote_control_off")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(auditText, /"action":"denied"/);
  assert.match(auditText, /remote_control_off/);
});

test("真实 Host：历史消息经脱敏后出网", async (t) => {
  const { app, faux } = await fixture(t);
  const base = new URL(app.mobile.url).origin;
  const token = encodeURIComponent(app.mobile.token);
  const snapshot = await (await fetch(`${base}/api/snapshot?t=${token}`)).json();
  const id = snapshot.list[0].sessionId;

  faux.setResponses([fauxAssistantMessage("HELLO")]);
  await fetch(`${base}/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${app.mobile.token}`,
    },
    body: JSON.stringify({ text: "问题" }),
  });

  // 等到 assistant 回复落地：用户消息先到，模型回合结束后才有答案。
  let history;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    history = await (await fetch(`${base}/api/sessions/${id}/transcript?t=${token}`)).json();
    if (history.messages.some((message) => message.text === "HELLO")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(history.messages.some((message) => message.text === "问题"), "用户消息必须可见");
  assert.ok(
    history.messages.some((message) => message.text === "HELLO"),
    `assistant 回复必须可见，实际：${JSON.stringify(history.messages)}`,
  );
  // 出网消息只保留渲染所需字段；content 保留形状但图片内容必须已清空。
  for (const message of history.messages) {
    assert.equal(typeof message.role, "string");
    assert.equal(typeof message.text, "string");
    assert(!JSON.stringify(message).includes("PRIVATE"), "不得夹带本机信息");
    for (const block of message.content ?? []) {
      if (block.type !== "image") continue;
      assert.equal(block.data, "", "图片内容必须清空");
      assert.equal(block.mimeType, "image/x-stripped");
    }
  }
});