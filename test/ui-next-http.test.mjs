import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";
import { UI_CHANNELS } from "../src/ui-next/channels.mjs";
import { UI_SUPPORT } from "../src/ui-next/support.mjs";
import { buildHostApi, HostApiUnsupported } from "../src/ui-next/host-api.mjs";

/**
 * 移植的传输层对**真实 Host**的验证。
 *
 * 目的：契约测试只能证明「有处理函数」；这里证明处理函数在真实 HTTP 上返回可用的数据。
 * 覆盖两类：已实现通道真的通、未实现通道真的报错（而不是返回空对象让界面以空数据渲染）。
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-ui-next-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(cwd, "README.md"), "# fixture\n");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "ui-fixture",
      defaultModel: "local",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const faux = fauxProvider({
    provider: "ui-fixture",
    models: [{ id: "local", reasoning: true }],
    tokensPerSecond: 10000,
  });
  providers.models.setProvider(faux.provider);
  const app = await startDurableDesk({
    cwd,
    agentDir,
    directory,
    providers,
    port: 0,
  });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });

  const origin = new URL(app.url).origin;
  const request = async (path, input) => {
    const response = await fetch(origin + path, {
      method: input === undefined ? "GET" : "POST",
      headers:
        input === undefined
          ? { Accept: "application/json" }
          : {
              Accept: "application/json",
              "Content-Type": "application/json",
              Origin: origin,
            },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : undefined;
    if (!response.ok)
      throw Object.assign(new Error(body?.error ?? `HTTP ${response.status}`), {
        status: response.status,
      });
    return body;
  };
  const handlers = createHttpHandlers({
    get: (path) => request(path),
    post: (path, input) => request(path, input),
  });
  const api = buildHostApi({
    channels: UI_CHANNELS,
    handlers,
    support: UI_SUPPORT,
    subscriptionSupport: {},
  });
  return { app, origin, api, handlers };
}

test("已实现通道在真实 Host 上返回可用数据", async (t) => {
  const f = await fixture(t);

  const sessions = await f.api.listSessions({});
  assert.ok(Array.isArray(sessions), "session:list 必须返回数组");
  if (sessions.length) {
    const row = sessions[0];
    assert.equal(typeof row.sessionId, "string", "sessionId 必须是字符串");
    assert.equal(typeof row.cwd, "string", "cwd 必须是字符串");
  }

  const all = await f.api.listAllSessions({});
  assert.ok(Array.isArray(all));

  const loaded = await f.api.getLoadedSessions({});
  assert.ok(Array.isArray(loaded));

  const messages = await f.api.getSessionMessages({});
  assert.ok(Array.isArray(messages), "session:getMessages 必须返回数组");

  const stats = await f.api.getStats({});
  assert.ok(stats === null || typeof stats === "object");

  const usage = await f.api.getContextUsage({});
  assert.ok(usage === null || typeof usage === "object");

  const commands = await f.api.listSlashCommands({});
  assert.ok(Array.isArray(commands), "斜杠命令必须是数组");

  const models = await f.api.listModels({});
  assert.ok(Array.isArray(models));

  const providers = await f.api.listProviders({});
  assert.ok(Array.isArray(providers), "settings:listProviders 必须返回数组");

  const mcp = await f.api.mcpConfigList({});
  assert.ok(Array.isArray(mcp.global));
  assert.ok(Array.isArray(mcp.project));
  assert.ok(Array.isArray(mcp.errors));
});

test("未实现通道抛可诊断错误，不返回空数据", async (t) => {
  const f = await fixture(t);
  // 权限应答：Host 有 /api/interaction-reply，但 Percho 的 allow/deny 语义尚未核实，
  // 因此必须明确报错而不是假装成功。
  await assert.rejects(
    () => f.api.respondPermission({ requestId: "r1", answer: "allow" }),
    (error) => {
      assert.ok(error instanceof HostApiUnsupported);
      assert.equal(error.channel, "permission:respond");
      assert.match(error.message, /尚未接入/);
      return true;
    },
  );
  // Percho 独有的子系统（更新器）同理：我们以 pi package 分发，没有内置更新器。
  await assert.rejects(
    () => f.api.checkForUpdates({}),
    (error) => {
      assert.ok(error instanceof HostApiUnsupported);
      assert.equal(error.channel, "update:check");
      assert.match(error.message, /尚未在此 Host 上实现/);
      return true;
    },
  );
});

test("会话创建与提示走真实 Host，返回 Percho 需要的身份", async (t) => {
  const f = await fixture(t);
  const created = await f.api.createSession({ options: {} });
  assert.ok(
    created?.sessionId || created?.id,
    "createSession 必须返回会话身份",
  );
  assert.equal(typeof (created.sessionId ?? created.id), "string");
});
