import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { concurrentFixture } from "./concurrent-fixture.mjs";
import { startWeb } from "../src/server/web.mjs";
import { createHttpHandlers } from "../src/ui-next/http-handlers.mjs";
import { createSessionTransport } from "../src/ui-next/session-transport.mjs";
import { toTranscript } from "../src/ui-next/session-projection.mjs";
import { perchoConsumers } from "./percho-fixture.mjs";
import {
  slashCommandViews,
  createProviderLogins,
} from "../src/ui-next/native-contracts.mjs";
import { createInteractionStore } from "../src/agent/interaction-store.mjs";
import { commandCatalog } from "../src/shared/pi-commands.mjs";
import { buildHostApi } from "../src/ui-next/host-api.mjs";
import { UI_CHANNELS } from "../src/ui-next/channels.mjs";
import { UI_SUPPORT } from "../src/ui-next/support.mjs";

function adapter(call, extra = {}) {
  const io = {
    get: (path) => call(path),
    post: (path, input) => call(path, input),
  };
  const sessions = createSessionTransport(io);
  return { sessions, h: createHttpHandlers({ ...io, sessions, ...extra }) };
}

test("Percho 提供商表单、原生凭据与 MCP CRUD 遵守真实 Host 协议", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const { h } = adapter(f.call);
  await h["session:create"]({ options: { cwd: f.cwd } });
  await h["settings:addCustomProvider"]({
    input: {
      id: "parity-provider",
      name: "Parity",
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      models: [
        {
          id: "first",
          reasoning: true,
          imageInput: true,
          contextWindow: 12000,
          maxTokens: 2000,
        },
        { id: "second" },
      ],
      apiKey: "fixture-only",
    },
  });
  let providers = await h["settings:listProviders"]();
  assert.equal(
    providers.find((row) => row.id === "parity-provider").models.length,
    2,
  );
  assert.equal(
    providers.find((row) => row.id === "parity-provider").configured,
    true,
  );
  await h["settings:saveApiKey"]({
    providerId: "parity-provider",
    key: "updated-fixture-only",
  });
  await h["settings:setProviderBaseUrl"]({
    providerId: "parity-provider",
    baseUrl: "http://127.0.0.1:10/v1",
    apiKey: "base-url-fixture-key",
  });
  providers = await h["settings:listProviders"]();
  assert.equal(
    providers.find((row) => row.id === "parity-provider").models.length,
    2,
  );
  assert.equal(
    providers.find((row) => row.id === "parity-provider").baseUrl,
    "http://127.0.0.1:10/v1",
  );
  await h["settings:saveApiKey"]({
    providerId: "openai",
    key: "not-a-real-key",
  });
  providers = await h["settings:listProviders"]();
  assert.equal(providers.find((row) => row.id === "openai").configured, true);
  assert.equal(
    providers.find((row) => row.id === "openai").authSource,
    "stored",
  );
  await h["settings:removeCredential"]({ providerId: "openai" });
  assert.equal(
    (await h["settings:listProviders"]()).find((row) => row.id === "openai")
      .configured,
    false,
  );
  assert.equal(f.requests.length, 0, "配置不提交模型请求");
  const result = await h["mcp:configUpsert"]({
    scope: "user",
    cwd: f.cwd,
    name: "parity-mcp",
    command: "node",
    args: ["--version"],
  });
  assert.equal(
    result.config.global.find((row) => row.name === "parity-mcp").transport
      .command,
    "node",
  );
  assert.equal(result.reload.reloaded, 0, "写盘不伪称运行态已经重载");
  assert.match(result.config.notice.message, /重载/);
  const updated = await h["mcp:configUpsert"]({
    scope: "user",
    cwd: f.cwd,
    name: "parity-mcp",
    enabled: false,
  });
  assert.equal(
    updated.config.global.find((row) => row.name === "parity-mcp").enabled,
    false,
  );
  assert.equal(
    updated.config.global.find((row) => row.name === "parity-mcp").transport
      .command,
    "node",
  );
  const removed = await h["mcp:configRemove"]({
    scope: "user",
    cwd: f.cwd,
    name: "parity-mcp",
  });
  assert(!removed.config.global.some((row) => row.name === "parity-mcp"));
});

test("内置 Provider 可直接覆写端点与凭据、恢复默认端点，目录元数据保留原生模型", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const { h } = adapter(f.call);
  await h["session:create"]({ options: { cwd: f.cwd } });
  const initial = (await h["settings:listProviders"]()).find(
    (row) => row.id === "openai",
  );
  assert(initial.models.length > 0, "无凭据的内置目录仍列出 SDK 已知模型");
  await h["settings:setProviderBaseUrl"]({
    providerId: "openai",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture-builtin-only",
  });
  let row = (await h["settings:listProviders"]()).find(
    (row) => row.id === "openai",
  );
  assert.equal(row.baseUrl, "http://127.0.0.1:9/v1");
  assert.equal(row.overridesBuiltin, true);
  assert.equal(row.configured, true);
  await h["settings:setProviderBaseUrl"]({ providerId: "openai", baseUrl: "" });
  row = (await h["settings:listProviders"]()).find(
    (row) => row.id === "openai",
  );
  assert.equal(
    row.baseUrl.replace(/\/$/, ""),
    initial.baseUrl.replace(/\/$/, ""),
  );
  assert.equal(row.configured, true, "恢复端点不清除凭据");
  assert(row.models.length > 0);
  assert.equal(f.requests.length, 0);
});

test("Provider 参数使用 Percho 的 providerId，端点修改保留随表单提交的凭据", async () => {
  const writes = [];
  const h = createHttpHandlers({
    get: async () => ({}),
    post: async () => ({}),
    sessions: {
      target: async () => ({ id: "fixture-session" }),
      get: async () => ({
        revision: "native-revision",
        rows: [{ id: "fixture", api: "openai-completions" }],
      }),
      post: async (path, body) => {
        writes.push({ path, body });
      },
    },
  });
  await h["settings:removeCustomProvider"]({ providerId: "fixture" });
  assert.deepEqual(writes.pop(), {
    path: "/api/provider-remove",
    body: { id: "fixture", revision: "native-revision" },
  });
  await h["settings:setProviderBaseUrl"]({
    providerId: "fixture",
    baseUrl: "https://example.invalid/v1",
    apiKey: "fixture-only",
  });
  assert.deepEqual(writes.pop(), {
    path: "/api/provider",
    body: {
      id: "fixture",
      api: "openai-completions",
      baseUrl: "https://example.invalid/v1",
      apiKey: "fixture-only",
      revision: "native-revision",
    },
  });
});

test("文件补全、输入绑定和文本附件到达同一真实会话，原文显示保持", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const { h } = adapter(f.call);
  const a = await h["session:create"]({ options: { cwd: f.cwd } });
  await h["session:create"]({ options: { cwd: f.other } });
  const file = join(f.cwd, "bound.ts");
  await writeFile(file, "export const bound = true;");
  assert((await h["project:listFiles"]({ cwd: f.cwd })).includes("bound.ts"));
  assert(
    (await h["project:listFiles"]({ cwd: f.cwd, path: "prompts" })).includes(
      "prompts/fixture-template.md",
    ),
  );
  assert.equal(await h["project:validateDirectory"]({ path: f.cwd }), f.cwd);
  await assert.rejects(
    () => h["project:validateDirectory"]({ path: "../relative" }),
    /绝对/,
  );
  const display = "检查 @别名.ts";
  await h["session:prompt"]({
    sessionId: a.sessionId,
    text: display,
    document: {
      version: 1,
      parts: [
        { type: "text", text: "检查 " },
        { type: "file", path: file, label: "别名.ts" },
      ],
    },
  });
  const messages = await until(
    () => h["session:getMessages"]({ sessionId: a.sessionId }),
    (rows) => rows.some((row) => row.role === "assistant"),
  );
  assert.equal(messages.find((row) => row.role === "user").text, display);
  assert(messages.find((row) => row.role === "user").sourceText.includes(file));
  assert(JSON.stringify(f.requests[0].messages).includes(file));
  await h["session:prompt"]({
    sessionId: a.sessionId,
    text: "READ_FILE",
    files: [
      {
        name: "context.txt",
        type: "text/plain",
        data: Buffer.from("fixture text attachment").toString("base64"),
      },
    ],
  });
  await until(
    () => h["session:getMessages"]({ sessionId: a.sessionId }),
    (rows) => rows.filter((row) => row.role === "assistant").length === 2,
  );
  const request = JSON.stringify(f.requests.at(-1).messages);
  const cached = /path=\\"([^\"]+)\\"/.exec(request)?.[1];
  assert(cached?.startsWith("/tmp/pi-desk-context-cache/"), request);
  t.after(() => rm(dirname(cached), { recursive: true, force: true }));
  assert.equal(await readFile(cached, "utf8"), "fixture text attachment");
  assert(
    !request.includes("fixture text attachment"),
    "沿用缓存路径，不悄悄改成大段内联文本",
  );
});

test("SDK Web 的 UUID 会话可列出、创建、重命名、按原生文件重开及关闭旧标签", async (t) => {
  const f = await concurrentFixture();
  t.after(() => f.stop());
  f.release("C");
  const app = await startWeb({
    cwd: f.root,
    agentDir: f.agentDir,
    host: "127.0.0.1",
    port: 0,
    noExtensions: true,
  });
  t.after(() => app.stop());
  await app.ready;
  const call = async (path, input) => {
    const origin = new URL(app.url).origin;
    const response = await fetch(
      origin + path,
      input === undefined
        ? {}
        : {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
    );
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.error), { status: response.status });
    return body;
  };
  const { h, sessions } = adapter(call);
  const listed = await h["session:listAll"]();
  assert.equal(listed.length, 1);
  const a = listed[0];
  assert.equal(a.branching, false);
  assert.equal(a.archivable, false);
  await call("/api/ui-state", { value: { theme: "dark" } });
  await call("/api/ui-state", { value: { language: "zh" } });
  assert.deepEqual((await call("/api/ui-state")).value, {
    theme: "dark",
    language: "zh",
  });
  assert.equal((await call("/api/daily-dir")).path, f.root);
  assert(
    (await h["models:list"]()).some(
      (row) => row.provider === "fixture" && row.authed,
    ),
  );
  await h["session:prompt"]({ sessionId: a.sessionId, text: "TASK C" });
  await until(
    () => sessions.state(a.sessionId),
    (state) =>
      state.idle &&
      state.messages.some((row) => row.text?.includes("completed-C")),
  );
  const first = (await h["session:listAll"]()).find(
    (row) => row.sessionId === a.sessionId,
  );
  assert(first.sessionFile.endsWith(".jsonl"));
  const b = await h["session:create"]({ options: {} });
  assert.notEqual(a.sessionId, b.sessionId);
  assert.notEqual(b.sessionId, "undefined");
  await h["session:prompt"]({ sessionId: a.sessionId, text: "ONLY_A_NATIVE" });
  await until(
    () => sessions.state(a.sessionId),
    (state) =>
      state.idle && state.messages.some((row) => row.text === "ONLY_A_NATIVE"),
  );
  assert(
    !(await h["session:getMessages"]({ sessionId: b.sessionId })).some(
      (row) => row.text === "ONLY_A_NATIVE",
    ),
  );
  assert.equal(
    (await call("/api/state")).sessionId,
    b.sessionId,
    "读写旧页不切换 TUI 的聚焦 slot",
  );
  await assert.rejects(
    () => sessions.path(`/api/state?sessionId=${b.sessionId}`, a.sessionId),
    /目标不一致/,
  );
  await h["session:setName"]({
    sessionId: b.sessionId,
    name: "SDK_NATIVE_RENAME",
  });
  await until(
    () => sessions.state(b.sessionId),
    (state) => state.name === "SDK_NATIVE_RENAME",
  );
  assert.equal(
    (await h["session:open"]({ filePath: first.sessionFile })).sessionId,
    a.sessionId,
  );
  assert.deepEqual(await h["session:close"]({ sessionId: b.sessionId }), {
    closed: true,
  });
  assert.equal((await call("/api/state")).sessionId, a.sessionId);
  const exported = await h["session:export"]({
    sessionId: a.sessionId,
    format: "jsonl",
  });
  assert.equal(JSON.parse(exported.split("\n")[0]).id, a.sessionId);
});

test("分支和退回精确定位原始条目，导出保持 Pi 原生 JSONL 树", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const { h, sessions } = adapter(f.call);
  const a = await h["session:create"]({ options: { cwd: f.cwd } });
  for (const [index, text] of ["FIRST_ROUND", "SECOND_ROUND"].entries()) {
    await h["session:prompt"]({ sessionId: a.sessionId, text });
    await until(
      () => h["session:getMessages"]({ sessionId: a.sessionId }),
      (rows) =>
        rows.filter((row) => row.role === "assistant").length === index + 1,
    );
  }
  const rows = await h["session:getMessages"]({ sessionId: a.sessionId });
  const assistant = rows.find((row) => row.role === "assistant");
  const fork = await h["session:fork"]({
    sessionId: a.sessionId,
    ref: { entryId: assistant.entryId },
  });
  assert.notEqual(fork.sessionId, a.sessionId);
  assert(
    !(await h["session:getMessages"]({ sessionId: fork.sessionId })).some(
      (row) => row.text.includes("SECOND_ROUND"),
    ),
  );
  await assert.rejects(
    () =>
      h["session:fork"]({ sessionId: a.sessionId, ref: { text: "UNKNOWN" } }),
    /位置不明确/,
  );
  const second = rows.find(
    (row) => row.role === "user" && row.text === "SECOND_ROUND",
  );
  const recalled = await h["session:recall"]({
    sessionId: a.sessionId,
    ref: { entryId: second.entryId },
  });
  assert.equal(recalled.text, "SECOND_ROUND");
  assert.deepEqual(recalled.images, []);
  const current = await sessions.state(a.sessionId);
  assert(
    !current.messages.some(
      (row) => row.role === "user" && row.text === "SECOND_ROUND",
    ),
  );
  const output = await h["session:export"]({
    sessionId: a.sessionId,
    format: "jsonl",
  });
  const entries = output
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  assert.equal(entries[0].type, "session");
  assert(entries[0].id);
  assert(
    entries.some(
      (row) =>
        row.type === "message" && JSON.stringify(row).includes("SECOND_ROUND"),
    ),
    "退回只移动 leaf，原树仍可导出",
  );
});

test("Git 分支读取和预览确认都绑定 cwd，取消不执行写入", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const git = promisify(execFile);
  for (const cwd of [f.cwd, f.other]) {
    await git("git", ["init", "-b", "main"], { cwd });
    await git("git", ["config", "user.name", "Fixture"], { cwd });
    await git("git", ["config", "user.email", "fixture@example.invalid"], {
      cwd,
    });
    await git("git", ["add", "."], { cwd });
    await git("git", ["commit", "--allow-empty", "-m", "fixture"], { cwd });
    await git("git", ["branch", "feature"], { cwd });
  }
  let approved = false;
  const plans = [];
  const { h, sessions } = adapter(f.call, {
    confirmGit: async (plan) => {
      plans.push(plan);
      return approved;
    },
    confirmTrust: async () => true,
  });
  const a = await h["session:create"]({ options: { cwd: f.cwd } });
  const b = await h["session:create"]({ options: { cwd: f.other } });
  for (const id of [a.sessionId, b.sessionId])
    await sessions.post("/api/project-trust", { trusted: true }, id);
  await h["project:checkoutBranch"]({ cwd: f.cwd, branch: "feature" });
  assert.equal(plans.length, 1);
  assert.equal(
    (
      await git("git", ["branch", "--show-current"], { cwd: f.cwd })
    ).stdout.trim(),
    "main",
  );
  approved = true;
  await h["project:checkoutBranch"]({ cwd: f.cwd, branch: "feature" });
  assert.equal(await h["project:getGitBranch"]({ cwd: f.cwd }), "feature");
  assert.equal(await h["project:getGitBranch"]({ cwd: f.other }), "main");
});

test("登录交互事件和应答对应真实 job，取消不注销现有凭据", async () => {
  const store = createInteractionStore();
  const events = [],
    paths = [];
  const sessions = {
    target: async () => ({ id: "owner" }),
    get: async (path) =>
      path === "/api/providers"
        ? { rows: [{ id: "fixture", auth: { oauth: true } }] }
        : { rows: store.list() },
    post: async (path, input) => {
      paths.push(path);
      if (path === "/api/auth-start")
        return {
          id: store.start("fixture", async (interaction) => {
            interaction.notify({
              type: "auth_url",
              url: "https://example.invalid/authorize",
            });
            const answer = await interaction.prompt({
              type: "secret",
              message: "Code",
            });
            assert.equal(answer, "CODE");
          }),
        };
      return store.reply(input);
    },
  };
  const login = createProviderLogins({
    sessions,
    emit: (name, event) => events.push({ name, ...event }),
  });
  const pending = login.start({ providerId: "fixture", loginId: "first" });
  const prompt = await until(
    async () => events.find((row) => row.kind === "prompt"),
    Boolean,
  );
  await login.respond({
    loginId: "first",
    promptId: prompt.promptId,
    value: "CODE",
  });
  assert.equal((await pending).ok, true);
  assert(
    events.some((row) => row.kind === "event" && row.event.type === "auth_url"),
  );
  const cancelling = login.start({ providerId: "fixture", loginId: "second" });
  await until(
    async () =>
      events.find((row) => row.loginId === "second" && row.kind === "prompt"),
    Boolean,
  );
  await login.cancel({ loginId: "second" });
  assert.equal((await cancelling).cancelled, true);
  assert(!paths.includes("/api/auth-logout"));
});

test("投影保留扩展卡片、原文、自动输入来源与流式工具，真实 Percho 消费者可使用", async () => {
  const input = [
    {
      role: "user",
      text: "EXPANDED",
      entryId: 1,
      presentation: { source: "user", original: "/template" },
    },
    { role: "user", text: "AUTO", presentation: { source: "automatic" } },
    {
      role: "custom",
      text: "",
      extensionView: {
        adapterId: "pi-desktop-card",
        version: 1,
        title: "CARD",
        body: "BODY",
        items: [],
        metrics: [],
      },
    },
  ];
  const state = toTranscript(input, {
    active: true,
    streaming: {
      id: "stream",
      text: "",
      blocks: [
        {
          type: "toolCall",
          id: "call",
          name: "bash",
          arguments: { command: "echo fixture" },
        },
      ],
    },
    activeCalls: [
      {
        id: "call",
        name: "bash",
        arguments: { command: "echo fixture" },
        output: "LIVE",
        status: "running",
      },
    ],
  });
  assert.equal(state.messages[0].text, "/template");
  assert.equal(state.messages[0].sourceText, "EXPANDED");
  assert.equal(state.messages[1].kind, "system");
  assert.equal(state.messages[1].desktop.source, "automatic");
  assert(
    state.messages.some((row) => row.desktop?.extensionView?.title === "CARD"),
  );
  const widgets = toTranscript([
    {
      role: "custom",
      id: "widget:fixture",
      customType: "pi-widget",
      content: "",
      display: true,
      details: {
        key: "fixture",
        placement: "aboveEditor",
        lines: ["SDK_WIDGET"],
      },
    },
  ]);
  assert(
    widgets.messages.some(
      (row) =>
        row.desktop?.extensionState === true &&
        row.desktop.extensionView.body.includes("SDK_WIDGET"),
    ),
  );
  assert.equal(state.streaming.tools[0].output, "LIVE");
  assert.equal(state.streaming.tools[0].state, "running");
  const consumer = await perchoConsumers();
  assert.doesNotThrow(() => consumer.buildChatRows(state, "fixture"));
  const recorded = toTranscript(
    [
      {
        role: "assistant",
        text: "",
        blocks: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }],
      },
    ],
    {
      active: true,
      activeCalls: [{ id: "call", name: "bash", output: "LIVE" }],
    },
  );
  assert.equal(recorded.messages[0].tools[0].output, "LIVE");
  assert.equal(recorded.messages[0].tools[0].state, "running");
  assert.equal(
    recorded.streaming.tools.length,
    0,
    "已提交调用的实时输出原位更新，不重复渲染调用",
  );
  const commands = slashCommandViews(
    commandCatalog({
      extensionRunner: {
        getRegisteredCommands: () => [{ invocationName: "fixture-command" }],
      },
      promptTemplates: [{ name: "fixture-template", description: "template" }],
      settingsManager: { getEnableSkillCommands: () => true },
      resourceLoader: {
        getSkills: () => ({ skills: [{ name: "fixture-skill" }] }),
      },
    }),
  );
  assert(commands.every((row) => row.supported === true));
  assert(
    consumer
      .filterCommands(commands, "fixture-template", (key) => key)
      .some(
        (row) => row.name === "fixture-template" && row.source === "template",
      ),
  );
  assert(
    consumer
      .filterCommands(commands, "fixture-command", (key) => key)
      .some((row) => row.name === "fixture-command"),
  );
});

test("桌面文件路径桥和外部链接保留平台能力，危险 URL 拒绝", async () => {
  const opened = [];
  const desktop = { filePath: () => "/fixture/native.txt" };
  const { h } = adapter(async () => ({}), {
    openExternal: (url) => opened.push(url),
  });
  const api = buildHostApi({
    channels: UI_CHANNELS,
    support: UI_SUPPORT,
    subscriptionSupport: {},
    handlers: h,
    desktop,
  });
  assert.equal(api.getPathForFile({}), "/fixture/native.txt");
  await api.openExternal({ url: "https://example.invalid/fixture" });
  assert.equal(opened.length, 1);
  await assert.rejects(
    () => api.openExternal({ url: "file:///etc/passwd" }),
    /HTTP/,
  );
  await assert.rejects(
    () => api.openExternal({ url: "javascript:alert(1)" }),
    /HTTP/,
  );
});
