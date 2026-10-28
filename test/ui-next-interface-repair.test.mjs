import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopFixture } from "./desktop-fixture.mjs";
import { createSessionTransport } from "../src/ui-next/session-transport.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";
import { createProviderLogins } from "../src/ui-next/native-contracts.mjs";
import { createInteractionStore } from "../src/agent/interaction-store.mjs";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { perchoConsumers } from "./percho-fixture.mjs";
import {
  CUSTOM_PROVIDER_APIS,
  MCP_EXPOSURES,
} from "../src/shared/resource-options.mjs";

test("Provider revision 读取挂起期间切换聊天，保存仍写入原 worker", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const gate = Promise.withResolvers(),
    started = Promise.withResolvers();
  let hold = false;
  const io = {
    get: async (path) => {
      const result = await f.call(path);
      if (hold && path.endsWith("/api/providers")) {
        hold = false;
        started.resolve();
        await gate.promise;
      }
      return result;
    },
    post: (path, body) => f.call(path, body),
  };
  const sessions = createSessionTransport(io),
    h = createHttpHandlers({ ...io, sessions });
  const a = await sessions.create({ cwd: f.cwd }),
    b = await sessions.create({ cwd: f.other });
  sessions.select(a.sessionId);
  hold = true;
  const saving = h["settings:addCustomProvider"]({
    input: {
      id: "fixed-owner",
      name: "Owner A",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "m" }],
    },
  });
  await started.promise;
  sessions.select(b.sessionId);
  gate.resolve();
  await saving;
  const aRows = (await f.call(`/agents/${a.sessionId}/api/providers`)).rows,
    bRows = (await f.call(`/agents/${b.sessionId}/api/providers`)).rows;
  assert(aRows.some((row) => row.id === "fixed-owner"));
  assert(!bRows.some((row) => row.id === "fixed-owner"));
  assert.equal(f.requests.length, 0);
});

for (const phase of ["target", "create"]) {
  test(`登录在 ${phase} 阶段取消仍有效，不留下运行任务`, async () => {
    const gate = Promise.withResolvers(),
      reached = Promise.withResolvers();
    const store = createInteractionStore();
    let started = 0,
      cancelled = 0;
    const sessions = {
      target: async () => {
        if (phase === "target") {
          reached.resolve();
          await gate.promise;
        }
        return { id: "fixed" };
      },
      get: async (path) =>
        path === "/api/providers"
          ? { rows: [{ id: "fixture", auth: { apiKey: true } }] }
          : { rows: store.list() },
      post: async (path, input) => {
        if (path === "/api/auth-start") {
          started++;
          const id = store.start("fixture", (i) =>
            i.prompt({ type: "secret", message: "Key" }),
          );
          if (phase === "create") {
            reached.resolve();
            await gate.promise;
          }
          return { id };
        }
        cancelled++;
        store.reply(input);
      },
    };
    const logins = createProviderLogins({ sessions });
    const pending = logins.start({
      loginId: "cancel-before-ready",
      providerId: "fixture",
    });
    await reached.promise;
    await logins.cancel({ loginId: "cancel-before-ready" });
    gate.resolve();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(started, phase === "target" ? 0 : 1);
    assert.equal(cancelled, phase === "target" ? 0 : 1);
    assert(store.list().every((job) => job.status !== "running"));
    await logins.cancel({ loginId: "already-ended" });
  });
}

test("草稿目录的文件、Git 和 MCP 完整读写不创建 worker，保留信任和 Git 确认", async (t) => {
  const f = await desktopFixture({ defaultConversation: false });
  t.after(() => f.close());
  const git = (args) => promisify(execFile)("git", args, { cwd: f.other });
  await writeFile(join(f.other, "draft.txt"), "draft");
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  await git(["branch", "feature"]);
  const io = {
    get: (path) => f.call(path),
    post: (path, input) => f.call(path, input),
  };
  let confirmations = 0;
  const h = createHttpHandlers({
    ...io,
    confirmTrust: async () => true,
    confirmGit: async (plan) => {
      assert(plan.token);
      confirmations++;
      return true;
    },
  });
  assert(
    (await h["project:listFiles"]({ cwd: f.other })).includes("draft.txt"),
  );
  await assert.rejects(
    () => h["project:listFiles"]({ cwd: f.other, path: "../" }),
    (error) => error.status === 403,
  );
  const branches = await h["project:listGitBranches"]({ cwd: f.other });
  assert.equal(branches.current, "main");
  assert(branches.branches.includes("feature"));
  assert.equal(
    await h["project:checkoutBranch"]({ cwd: f.other, branch: "feature" }),
    "feature",
  );
  assert.equal(confirmations, 1);
  await mkdir(join(f.other, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(f.other, ".pi", "extensions", "noop.mjs"),
    "export default function(){}",
  );
  let mcp = await h["mcp:configList"]({ cwd: f.other });
  assert.equal(mcp.projectTrusted, false);
  assert.equal(mcp.project.length, 0);
  assert.equal(mcp.globalPath, join(f.agentDir, "mcp.json"));
  assert.equal(mcp.projectPath, join(f.other, ".pi", "mcp.json"));
  await assert.rejects(
    () => h["project:listGitBranches"]({ cwd: f.other }),
    (error) => error.status === 403,
  );
  assert.equal(await h["project:ensureTrust"]({ cwd: f.other }), true);
  for (const exposure of MCP_EXPOSURES) {
    const result = await h["mcp:configUpsert"]({
      cwd: f.other,
      scope: "project",
      name: "fixture-mcp",
      command: "node",
      args: ["--version"],
      exposure,
    });
    assert.equal(result.config.project[0].exposure, exposure);
  }
  mcp = await h["mcp:configList"]({ cwd: f.other });
  assert.equal(mcp.projectTrusted, true);
  assert.equal(
    (await h["mcp:configReload"]({ cwd: f.other })).reload.reloaded,
    0,
  );
  await h["mcp:configRemove"]({
    cwd: f.other,
    scope: "project",
    name: "fixture-mcp",
  });
  assert.equal((await h["mcp:configList"]({ cwd: f.other })).project.length, 0);
  assert.equal((await f.call("/api/workspace")).agents.length, 0);
  assert.equal(f.requests.length, 0);
  const response = await fetch(
    new URL(
      `/api/workspace/project-files?cwd=${encodeURIComponent(f.other)}`,
      f.app.url,
    ),
    { headers: { "x-pi-remote-client": "1" } },
  );
  assert.equal(response.status, 403);
  const live = createSessionTransport(io);
  await live.create({ cwd: f.other });
  const nested = join(f.other, "nested");
  await mkdir(nested);
  await assert.rejects(
    () => h["project:checkoutBranch"]({ cwd: nested, branch: "main" }),
    (error) => error.status === 409,
    "草稿子目录不能绕过同仓库 worker 的写入所有权",
  );
});

test("前端协议选择与新 Provider 装载一致，内置自定义模型继续使用 SDK Provider", async (t) => {
  const f = await desktopFixture({ defaultConversation: false });
  t.after(() => f.close());
  const directory = join(f.root, "model-test");
  await mkdir(directory);
  const app = await openDurableModels({ agentDir: f.agentDir, directory });
  const { KNOWN_APIS, PERCHO_MCP_EXPOSURES } = await perchoConsumers();
  assert.deepEqual(KNOWN_APIS, CUSTOM_PROVIDER_APIS);
  assert.deepEqual(PERCHO_MCP_EXPOSURES, MCP_EXPOSURES);
  for (const api of KNOWN_APIS) {
    const id = `fixture-${api}`;
    await app.save({
      id,
      name: "Friendly provider",
      api,
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "custom" }],
      revision: (await app.inventory()).revision,
    });
    assert(app.models.getModel(id, "custom"));
    assert.equal(app.models.getProvider(id).name, "Friendly provider");
  }
  for (const id of [
    "google-vertex",
    "mistral",
    "amazon-bedrock",
    "openai-codex",
  ]) {
    const builtin = app.models.getProvider(id),
      api = builtin.getModels()[0].api;
    const oauth = !!builtin.auth.oauth;
    await app.save({
      id,
      name: "Custom builtin",
      api,
      baseUrl: "https://example.invalid/v1",
      models: [{ id: "custom", contextWindow: 32000 }],
      revision: (await app.inventory()).revision,
    });
    const model = app.models.getModel(id, "custom");
    assert(model);
    assert.equal(model.api, api);
    assert.equal(model.baseUrl, "https://example.invalid/v1");
    assert.equal(!!app.models.getProvider(id).auth.oauth, oauth);
  }
  const id = "fixture-openai-completions";
  await app.save({
    id,
    name: "",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    revision: (await app.inventory()).revision,
  });
  assert.equal(app.models.getProvider(id).name, id);
  assert.equal(
    JSON.parse(await readFile(join(directory, "models.json"), "utf8"))
      .providers[id].name,
    "",
  );
});
