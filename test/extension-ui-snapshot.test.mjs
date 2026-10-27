import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";

/**
 * 扩展 UI 能力在真实 Host 上的投影。
 *
 * conformance suite 验证适配器单元；这里验证同一份报告经 `/api/state` 到达客户端，且
 * `/api/composer` 的输入框镜像被真实 worker 接受。两者都跑真实 host、真实 SQLite 与真实桥。
 */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-ui-capability-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultTools: ["read"],
      defaultProvider: "cap-fixture",
      defaultModel: "local",
      cacheWarming: "off",
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const faux = fauxProvider({
    provider: "cap-fixture",
    models: [{ id: "local" }],
    tokensPerSecond: 10000,
  });
  providers.models.setProvider(faux.provider);
  const app = await startDurableDesk({ cwd, agentDir, directory, providers, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  const origin = new URL(app.url).origin;
  const call = async (path, input) => {
    const response = await fetch(origin + path, {
      method: input === undefined ? "GET" : "POST",
      headers: input === undefined ? {} : { Origin: origin, "Content-Type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const value = await response.json();
    return { status: response.status, body: value };
  };
  return { app, faux, call, origin };
}

test("snapshot 投影扩展 UI 能力报告与可见状态", async (t) => {
  const f = await fixture(t);
  const state = await f.call("/api/state");
  assert.equal(state.status, 200, JSON.stringify(state.body));

  const ui = state.body.ui ?? {};
  assert.ok(ui.capabilities, "snapshot 必须带 ui.capabilities");

  const members = ui.capabilities.members ?? {};
  assert.ok(Object.keys(members).length > 0, "能力报告必须覆盖 ExtensionUIContext 成员");
  for (const [name, entry] of Object.entries(members)) {
    assert.ok(
      ["native", "degraded", "refused"].includes(entry.level),
      `${name} 的层级无效：${entry.level}`,
    );
    assert.equal(typeof entry.used, "number", `${name} 必须带使用计数`);
    if (entry.level !== "native")
      assert.ok(entry.reason, `${name} 声明为 ${entry.level} 时必须带原因`);
  }
  assert.ok(Array.isArray(ui.capabilities.usedMembers));
  assert.equal(typeof ui.workingVisible, "boolean");
  assert.equal(typeof ui.toolsExpanded, "boolean");
  assert.equal(typeof ui.hiddenThinkingLabel, "string");
  assert.equal(typeof ui.capabilities.counts.native, "number");
});

test("/api/composer 接受镜像并拒绝非法正文", async (t) => {
  const f = await fixture(t);

  const ok = await f.call("/api/composer", { text: "扩展看到的草稿" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const tooLong = await f.call("/api/composer", { text: "x".repeat(50001) });
  assert.equal(tooLong.status, 422);

  const wrongType = await f.call("/api/composer", { text: 42 });
  assert.equal(wrongType.status, 422);

  // 镜像不影响会话身份与消息数量。
  const state = await f.call("/api/state");
  assert.equal(state.body.messages.length, 0);
});
