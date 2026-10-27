import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";

/**
 * 手机端（局域网）契约。
 *
 * 目的：手机端是独立边界——独立端口、独立令牌、可选 TLS。这里断言：
 *   1. 令牌真的挡住读写（401），而不是只有页面弹窗；
 *   2. 桌面端口不暴露手机端 API（两套边界不互相穿透）；
 *   3. 启用 TLS 时证书可用于真实握手，且 SAN 覆盖本机地址。
 *
 * 测试不关闭证书校验：TLS 用例把生成的证书作为 `ca` 传入，相当于"只信任这一张"。
 */
async function fixture(t, { tls = false } = {}) {
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
  const app = await startDurableDesk({
    cwd,
    agentDir,
    directory,
    providers,
    port: 0,
    mobileTls: tls,
  });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { app, faux, cwd, directory };
}

const status = async (url, init) => (await fetch(url, init)).status;

test("手机端在独立端口提供服务，页面无需令牌即可加载", async (t) => {
  const { app } = await fixture(t);
  assert.ok(app.mobile, "应启动手机端服务");
  assert.ok(app.mobile.port > 0);
  assert.notEqual(app.mobile.port, Number(new URL(app.url).port));

  const page = await fetch(app.mobile.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.ok(html.includes('<div id="root">'), "必须是已构建的单文件页面");
  assert.ok(!/<script[^>]+src="\/assets\//.test(html), "手机端页面必须内联");
});

test("未授权请求一律 401，令牌不能靠路径猜测获得", async (t) => {
  const { app } = await fixture(t);
  const base = new URL(app.mobile.url).origin;

  assert.equal(await status(`${base}/api/snapshot`), 401);
  assert.equal(await status(`${base}/api/snapshot?t=nope`), 401);
  assert.equal(await status(`${base}/api/nonexistent`), 404);
  assert.equal(await status(`${base}/api/permissions/x/respond`, { method: "POST" }), 404);

  const snapshot = await (
    await fetch(`${base}/api/snapshot?t=${encodeURIComponent(app.mobile.token)}`)
  ).json();
  const id = snapshot.list?.[0]?.sessionId;
  assert.ok(id, "至少有一个会话");
  assert.equal(
    await status(`${base}/api/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    }),
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
  assert.equal(typeof row.modifiedAt, "number");
  // 活跃投影已接入：每个会话都带 view，且 transcript 与 view 同集合。
  assert.equal(snapshot.views.length, snapshot.list.length);
  assert.equal(snapshot.transcripts.length, snapshot.list.length);
  const view = snapshot.views.find((row) => row.sessionId === row.sessionId);
  assert.equal(typeof view.name, "string");
  assert.equal(typeof view.agentActive, "boolean");
  assert.equal(typeof view.lastActivity, "number");
  assert.ok(view.currentTool === null || typeof view.currentTool === "string");
  assert.ok(view.stats === null || typeof view.stats.cost === "number");

  const history = await (
    await fetch(`${base}/api/sessions/${row.sessionId}/transcript?t=${token}`)
  ).json();
  assert.equal(history.sessionId, row.sessionId);
  assert.ok(Array.isArray(history.messages));
  assert.equal(history.truncated, false);

  faux.setResponses([fauxAssistantMessage("MOBILE_OK")]);
  assert.equal(
    await status(`${base}/api/sessions/${row.sessionId}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${app.mobile.token}`,
      },
      body: JSON.stringify({ text: "来自手机" }),
    }),
    200,
  );

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
  assert.equal(await status(`${desktop}/api/snapshot`), 404);
  assert.equal(await status(`${desktop}/api/stream`), 404);
});

test("启用 TLS 时自签证书可完成真实握手，SAN 覆盖本机地址", async (t) => {
  const { app, directory } = await fixture(t, { tls: true });
  assert.equal(app.mobile.scheme, "https");
  assert.ok(app.mobile.url.startsWith("https://"));

  const certPath = join(directory, "tls-cert.pem");
  const keyPath = join(directory, "tls-key.pem");
  const cert = await readFile(certPath, "utf8");
  const parsed = new X509Certificate(cert);
  assert.ok(parsed.subjectAltName?.includes("IP Address:127.0.0.1"), "SAN 必须含回环");
  assert.ok(parsed.verify(parsed.publicKey), "必须是自洽的自签证书");

  // 私钥不得进入证书文件，且权限受控。
  assert.ok(!cert.includes("PRIVATE KEY"));
  const keyStat = await readFile(keyPath, "utf8");
  assert.ok(keyStat.includes("PRIVATE KEY"));

  // 用这张证书作为唯一信任根完成握手（不关闭校验）。
  const body = await new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port: app.mobile.port,
        path: `/api/snapshot?t=${encodeURIComponent(app.mobile.token)}`,
        ca: [cert],
        rejectUnauthorized: true,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(body.status, 200, body.body);
  assert.ok(JSON.parse(body.body).list.length >= 1);

  // 同一张证书也覆盖页面本身（页面无需令牌）。
  const page = await new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: "127.0.0.1", port: app.mobile.port, path: "/", ca: [cert] },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(page, 200);
});
