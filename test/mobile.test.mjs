import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";

/**
 * 手机端（局域网）契约。
 *
 * 目的：手机端是独立边界——独立端口、独立令牌。这里断言三件事：
 *   1. 令牌真的挡住读写（401），而不是只有页面弹窗；
 *   2. 桌面端口不暴露手机端 API（两套边界不互相穿透）；
 *   3. 令牌路径与写端点按契约工作。
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "mobile-fixture",
      defaultModel: "local",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const faux = fauxProvider({
    provider: "mobile-fixture",
    models: [{ id: "local" }],
    tokensPerSecond: 10000,
  });
  providers.models.setProvider(faux.provider);
  const app = await startDurableDesk({ cwd, agentDir, directory, providers, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { app, faux, cwd };
}

const json = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, text };
};

test("手机端在独立端口提供服务，且页面无需令牌即可加载", async (t) => {
  const { app } = await fixture(t);
  assert.ok(app.mobile, "应启动手机端服务");
  assert.ok(app.mobile.port > 0);
  // 独立端口：与桌面入口不同。
  assert.notEqual(app.mobile.port, new URL(app.url).port);

  const page = await fetch(app.mobile.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.ok(html.includes("<div id=\"root\">"), "必须是已构建的单文件页面");
  // 单文件：不应引用外部 chunk。
  assert.ok(!/<script[^>]+src="\/assets\//.test(html), "手机端页面必须内联");
});

test("未授权请求一律 401，令牌不能靠路径猜测获得", async (t) => {
  const { app } = await fixture(t);
  const base = new URL(app.mobile.url).origin;

  assert.equal((await json(`${base}/api/snapshot`)).status, 401);
  assert.equal((await json(`${base}/api/snapshot?t=nope`)).status, 401);
  assert.equal((await json(`${base}/api/nonexistent`)).status, 404);

  // 写端点同样要求令牌，且不接受无令牌请求体。
  const snapshot = await (
    await fetch(`${base}/api/snapshot?t=${encodeURIComponent(app.mobile.token)}`)
  ).json();
  const id = snapshot.list?.[0]?.sessionId;
  assert.ok(id, "至少有一个会话");
  assert.equal(
    (
      await json(`${base}/api/sessions/${id}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x" }),
      })
    ).status,
    401,
  );
});

test("有效令牌可读快照与历史，并可用 Bearer 写", async (t) => {
  const { app, faux } = await fixture(t);
  const base = new URL(app.mobile.url).origin;
  const token = encodeURIComponent(app.mobile.token);

  const snapshot = await (await fetch(`${base}/api/snapshot?t=${token}`)).json();
  assert.equal(typeof snapshot.serverTime, "number");
  assert.ok(Array.isArray(snapshot.list));
  const row = snapshot.list[0];
  assert.equal(typeof row.sessionId, "string");
  assert.equal(typeof row.name, "string");
  assert.equal(typeof row.cwd, "string");
  assert.equal(typeof row.active, "boolean");
  // 活跃投影尚未适配：明确为空，而不是伪造内容。
  assert.deepEqual(snapshot.views, []);
  assert.deepEqual(snapshot.transcripts, []);

  const history = await (
    await fetch(`${base}/api/sessions/${row.sessionId}/transcript?t=${token}`)
  ).json();
  assert.equal(history.sessionId, row.sessionId);
  assert.ok(Array.isArray(history.messages));
  assert.equal(history.truncated, false);

  faux.setResponses([fauxAssistantMessage("MOBILE_OK")]);
  const written = await json(`${base}/api/sessions/${row.sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${app.mobile.token}` },
    body: JSON.stringify({ text: "来自手机" }),
  });
  assert.equal(written.status, 200);

  // 消息真的进了会话。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const after = await (
      await fetch(`${base}/api/sessions/${row.sessionId}/transcript?t=${token}`)
    ).json();
    if (after.messages.some((message) => message.text === "来自手机")) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("手机端写入的消息未进入会话转录");
});

test("桌面端口不暴露手机端 API", async (t) => {
  const { app } = await fixture(t);
  const desktop = new URL(app.url).origin;
  assert.equal((await json(`${desktop}/api/snapshot`)).status, 404);
  assert.equal((await json(`${desktop}/api/stream`)).status, 404);
});