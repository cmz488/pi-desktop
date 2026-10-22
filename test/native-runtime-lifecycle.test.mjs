import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEmbeddedPiSdk } from "../src/agent/pi-sdk.mjs";
import { createNativeRuntime } from "../src/agent/native-runtime.mjs";
import {
  standardExtensionFixture,
  readExtensionTrace,
} from "./standard-extension-fixture.mjs";

// 这里直接持有 SDK 创建的 context，才能观察重载后的过期访问，而非模拟一份失效标志。
test("原生桥不绕过 Pi 的旧 context 失效保护", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-context-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  let session, native;
  t.after(async () => {
    await native?.dispose();
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const sdk = await loadEmbeddedPiSdk();
  const settingsManager = sdk.SettingsManager.create(cwd, agentDir);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  });
  ({ session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    modelRuntime,
    sessionManager: sdk.SessionManager.inMemory(cwd),
  }));
  const calls = [];
  native = createNativeRuntime({
    id: 1,
    workspace: {
      subscribe: () => () => {},
      execute: async (...args) => calls.push(args),
    },
    ready: async () => {},
    syncTools: async () => {},
    onError: (error) => {
      throw error;
    },
  });
  native.bind(session);
  await session.bindExtensions({
    mode: "rpc",
    onError: (event) => assert.fail(event.error),
  });
  const old = session.extensionRunner.createContext();
  assert(old.signal);
  assert.equal(old.isIdle(), true);
  await session.reload({ beforeSessionStart: () => native.bind(session) });
  for (const [name, access] of [
    ["isIdle", () => old.isIdle()],
    ["hasPendingMessages", () => old.hasPendingMessages()],
    ["signal", () => old.signal],
    ["abort", () => old.abort()],
  ])
    assert.throws(access, undefined, `${name} 必须保留原生 stale-context 错误`);
  assert.equal(calls.length, 0, "过期 abort 不能中止仍在使用的新会话");
  const current = session.extensionRunner.createContext();
  assert(current.signal);
  assert.equal(current.isIdle(), true);
});

test("真实安装扩展在 reload 的 session_start 前重绑上下文并清除已卸载状态", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  const start = (await readExtensionTrace(f.cwd)).findLast(
    (row) => row.type === "session_start",
  );
  assert.equal(start.reason, "reload");
  assert.equal(
    start.hasSignal,
    true,
    "启动 handler 本身就必须获得 Durable signal，不能等下一次读取才绑定",
  );
  await f.api("prompt", { sessionId: f.id, message: "/notes-status reload" });
  const starts = (await readExtensionTrace(f.cwd)).filter(
    (row) => row.type === "session_start",
  );
  assert.equal(
    starts.length,
    3,
    "标准 command context 的 reload 也走同一重绑路径",
  );
  assert.equal(starts.at(-1).hasSignal, true);
  assert.equal(
    (await f.api("commands")).rows.filter((row) => row.name === "notes-status")
      .length,
    1,
  );
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_PING" });
  await f.settled();
  const rows = await readExtensionTrace(f.cwd);
  const before = rows.findLast((row) => row.type === "before_agent_start");
  const execution = rows.findLast((row) => row.type === "execute");
  assert.equal(before.idle, false);
  assert.equal(execution.contextSignal, true);
  assert.equal(execution.toolSignal, true);
  assert.equal(execution.idle, false);
  const settings = f.sdk.SettingsManager.create(f.cwd, f.agentDir, {
    projectTrusted: true,
  });
  const packages = settings.getPackages();
  settings.setPackages([{ source: packages[0], extensions: [] }, packages[1]]);
  await settings.flush();
  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  assert(
    !(await f.api("state")).statuses.includes("笔记工具就绪"),
    "卸载后的旧 UI 状态不能继续冒充活跃扩展",
  );
});
