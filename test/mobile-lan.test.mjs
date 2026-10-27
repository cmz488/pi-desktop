import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";

/**
 * 跨设备互联（lan:*）契约：状态/二维码、开关、远程控制。
 *
 * 目的：Percho 的设置页靠这三个通道渲染二维码与开关。这里断言它们背后是真实服务：
 *   关掉之后端口真的不再监听、重开换令牌、远程控制关掉之后写端点真的 403。
 */
async function fixture(t, { tls = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-mobile-lan-"));
  const cwd = join(root, "p"),
    agentDir = join(root, "a"),
    directory = join(root, "d");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultTools: ["read"], defaultProvider: "p", defaultModel: "m", cacheWarming: "off" }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const app = await startDurableDesk({ cwd, agentDir, directory, providers, port: 0, mobileTls: tls });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { app, directory };
}

const lanCall = async (app, input) => {
  const origin = new URL(app.url).origin;
  const response = await fetch(`${origin}/api/lan`, {
    method: input === undefined ? "GET" : "POST",
    headers:
      input === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json", Origin: origin },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return { status: response.status, body: await response.json() };
};

test("状态带 https 地址与二维码", async (t) => {
  const { app } = await fixture(t, { tls: true });
  const first = await lanCall(app);
  assert.equal(first.status, 200);

  const status = first.body.status;
  assert.equal(status.enabled, true);
  assert.equal(typeof status.port, "number");
  assert.ok(Array.isArray(status.urls) && status.urls.length > 0, "必须给出可扫码地址");
  assert.match(status.urls[0], /^https:\/\//, "地址必须是 https");
  assert.match(status.urls[0], /\?t=/, "地址必须带令牌");
  assert.match(status.qrDataUrl ?? "", /^data:image\/png;base64,/, "必须给出二维码");
  assert.equal(status.remoteControl, true);
});

test("关闭后不再监听，重开换令牌", async (t) => {
  const { app } = await fixture(t);
  const before = (await lanCall(app)).body.status;
  assert.equal(before.enabled, true);

  const off = await lanCall(app, { enabled: false });
  assert.equal(off.body.status.enabled, false);
  assert.equal(off.body.status.port, null);
  assert.deepEqual(off.body.status.urls, []);
  assert.equal(off.body.status.qrDataUrl, null);

  const on = await lanCall(app, { enabled: true });
  assert.equal(on.body.status.enabled, true);
  assert.equal(typeof on.body.status.port, "number");
  assert.notEqual(on.body.status.urls[0], before.urls[0], "重开必须换令牌");

  assert.equal((await lanCall(app, { nope: 1 })).status, 422);
});

test("远程控制关闭时手机端写端点明确 403", async (t) => {
  const { app, directory } = await fixture(t, { tls: true });
  await lanCall(app, { remoteControl: false });

  const cert = await readFile(join(directory, "tls-cert.pem"), "utf8");

  // fetch（undici）不认 agent 选项，所以用 node:https 直接发请求，
  // 并把生成的证书作为唯一信任根（不关闭校验）。
  const send = (path, init = {}) =>
    new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port: app.mobile.port,
          path,
          ca: [cert],
          method: init.method ?? "GET",
          headers: init.headers,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );
      request.on("error", reject);
      if (init.body) request.write(init.body);
      request.end();
    });

  const token = encodeURIComponent(app.mobile.token);
  const snapshot = JSON.parse((await send(`/api/snapshot?t=${token}`)).text);
  const id = snapshot.list[0].sessionId;

  const denied = await send(`/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${app.mobile.token}`,
    },
    body: JSON.stringify({ text: "不应写入" }),
  });
  assert.equal(denied.status, 403);
  assert.match(denied.text, /远程控制未开启/);
});