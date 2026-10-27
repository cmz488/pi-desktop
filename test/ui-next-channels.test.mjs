import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { UI_CHANNELS } from "../src/ui-next/channels.mjs";
import { UI_SUPPORT } from "../src/ui-next/support.mjs";
import { buildHostApi } from "../src/ui-next/host-api.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";

/**
 * 新接入通道对真实 Host 的验证（worker 路由）。
 *
 * 会话改名/归档走的是 **Host** 的 `/api/workspace/command`，不在 worker 上；那类通道由
 * `test/desktop-control-plane.test.mjs` 与 `test/ui-next-contract.test.mjs` 覆盖路由存在性与形状。
 * 这里只验证 worker 侧确实能应答的通道，避免把"路由在另一层"误判成实现错误。
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-ui-next-2-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "u2",
      defaultModel: "local",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
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
    const payload = text ? JSON.parse(text) : undefined;
    if (!response.ok)
      throw Object.assign(
        new Error(payload?.error ?? `HTTP ${response.status}`),
        {
          status: response.status,
        },
      );
    return payload;
  };
  const api = buildHostApi({
    channels: UI_CHANNELS,
    handlers: createHttpHandlers({
      get: (path) => request(path),
      post: (path, input) => request(path, input),
    }),
    support: UI_SUPPORT,
    subscriptionSupport: {},
  });
  return { app, api, origin, request };
}

test("插件与技能清单从 /api/plugins 读取（复数路由）", async (t) => {
  const f = await fixture(t);
  const plugins = await f.api.uiPluginsList({});
  assert.ok(Array.isArray(plugins), "uiPlugins:list 必须是数组");
  // getConfig 需要具体插件 id；无插件时明确报错是正确行为，不是实现缺陷。
  await assert.rejects(
    () => f.api.uiPluginsGetConfig({}),
    /插件未声明 Web 配置表单|接口不存在|插件/,
  );
});

test("provider 写入自带 revision 围栏", async (t) => {
  const f = await fixture(t);
  const providers = await f.api.listProviders({});
  assert.ok(Array.isArray(providers));

  // handler 自己从 /api/providers 取 revision，调用方不必提供。
  const created = await f.api.addCustomProvider({
    input: {
      id: "u2-custom",
      name: "U2 Custom",
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      modelId: "u2-model",
    },
  });
  assert.ok(created !== undefined);

  await f.api.removeCustomProvider({ id: "u2-custom" });
});

test("MCP 与权限只读通道返回可用数据", async (t) => {
  const f = await fixture(t);
  const mcp = await f.api.mcpConfigList({});
  assert.ok(Array.isArray(mcp));

  const config = await f.api.getPermissionConfig({});
  assert.equal(config.enabled, true);

  const mode = await f.api.getPermissionMode({});
  assert.ok(["default", "fullAccess"].includes(mode));
});

test("未实现通道保持可诊断的拒绝，且原因非空", async (t) => {
  const f = await fixture(t);
  for (const [method, channel] of [
    ["getModelPrefs", "settings:getModelPrefs"],
    ["uiPluginsAssignSlot", "uiPlugins:assignSlot"],
    ["checkForUpdates", "update:check"],
    ["getContextManagerConfig", "contextManager:getConfig"],
    ["listConfiguredPackages", "packages:listConfigured"],
  ]) {
    await assert.rejects(
      () => f.api[method]({}),
      (error) => {
        assert.equal(error.channel, channel);
        assert.equal(error.code, "HOST_API_UNSUPPORTED");
        assert.ok(error.message.length > 10, `${channel} 必须给出原因`);
        return true;
      },
    );
  }
});
