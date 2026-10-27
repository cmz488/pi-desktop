import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";
import { UI_CHANNELS } from "../src/ui-next/channels.mjs";
import { UI_SUPPORT } from "../src/ui-next/support.mjs";
import { buildHostApi } from "../src/ui-next/host-api.mjs";

/**
 * UI 状态持久化对真实 Host 的验证。
 *
 * 目的：侧栏折叠、置顶、主题这些值必须跨页面刷新存活。只测「调用不报错」不够——
 * 这里断言写入后真的落到磁盘、并且重新读取拿到同一份值。
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-ui-state-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "ui-state",
      defaultModel: "local",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const app = await startDurableDesk({ cwd, agentDir, directory, providers, port: 0 });
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
          : { Accept: "application/json", "Content-Type": "application/json", Origin: origin },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : undefined;
    if (!response.ok)
      throw Object.assign(new Error(payload?.error ?? `HTTP ${response.status}`), {
        status: response.status,
      });
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
  return { api, directory, origin, request };
}

test("uiState 写入后落盘，重新读取拿到同一份值", async (t) => {
  const f = await fixture(t);

  // 从未写过时是 null，而不是空对象——渲染层据此判断「首次运行」。
  assert.equal(await f.api.loadUiState({}), null);

  const value = {
    lastUsedModel: { provider: "ui-state", modelId: "local" },
    lastUsedThinkingLevel: "medium",
    theme: "dark",
    pinnedSessions: ["3"],
    sessionRailEnabled: false,
  };
  const saved = await f.api.saveUiState({ value });
  assert.deepEqual(saved, value, "save 必须回显写入的内容");

  // 真的落盘了。
  const onDisk = JSON.parse(
    await readFile(join(f.directory, "ui-state.json"), "utf8"),
  );
  assert.deepEqual(onDisk, value);

  // 重新读取（等价于页面刷新）拿到同一份值。
  assert.deepEqual(await f.api.loadUiState({}), value);
});

test("environmentUiState 与 uiState 是两个独立文档", async (t) => {
  const f = await fixture(t);

  const nav = {
    version: 1,
    projects: ["/tmp/a"],
    dailyDirs: [],
    pinnedSessions: [],
    pinnedProjects: [],
    expandedGroups: [],
    expandedGroupsTouched: false,
    lastCwd: null,
    workspace: { members: [], activeFile: null, recentFile: null },
    catalog: [],
  };
  await f.api.saveEnvironmentUiState({ value: nav });
  await f.api.saveUiState({ value: { theme: "light" } });

  assert.deepEqual(await f.api.loadEnvironmentUiState({}), nav);
  assert.deepEqual(await f.api.loadUiState({}), { theme: "light" });
  assert.ok((await readFile(join(f.directory, "ui-state.json"), "utf8")).length > 0);
  assert.ok(
    (await readFile(join(f.directory, "environment-ui-state.json"), "utf8")).length > 0,
  );
});

test("非法写入被拒绝，且不覆盖已有内容", async (t) => {
  const f = await fixture(t);
  const good = { theme: "dark" };
  await f.api.saveUiState({ value: good });

  // 数组不是 UI 状态文档；类型错误必须在边界拒绝。
  await assert.rejects(() => f.request("/api/ui-state", { value: [1, 2] }), /JSON 对象/);
  await assert.rejects(() => f.request("/api/ui-state", {}), /JSON 对象/);

  // 超过 1 MiB 的文档同样拒绝。
  await assert.rejects(
    () => f.request("/api/ui-state", { value: { blob: "x".repeat(1024 * 1024 + 1) } }),
    /过大/,
  );

  // 拒绝之后旧内容仍在。
  assert.deepEqual(await f.api.loadUiState({}), good);
});

test("损坏的文档明确失败，不静默清空用户偏好", async (t) => {
  const f = await fixture(t);
  await f.api.saveUiState({ value: { theme: "dark" } });
  await writeFile(join(f.directory, "ui-state.json"), "{ not json");

  await assert.rejects(() => f.api.loadUiState({}), /不是有效 JSON/);
});

test("daily 目录按工作空间隔离，且是绝对路径", async (t) => {
  const f = await fixture(t);
  const dir = await f.api.getDailyDir({});
  assert.equal(typeof dir, "string");
  assert.ok(dir.startsWith("/"), "daily 目录必须是绝对路径");
  assert.ok(dir.startsWith(f.directory), "daily 目录必须在该工作空间的数据目录下");
});