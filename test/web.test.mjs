import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWeb } from "../src/server/web.mjs";
import { readDocument } from "../src/config/config-store.mjs";
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-sdk-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      customUntouched: { keep: true },
      compaction: { enabled: true, keepRecentTokens: 12345 },
    }),
  );
  const app = await startWeb({
    agentDir,
    cwd,
    port: 0,
    noExtensions: true,
    ...options,
  });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  await app.ready;
  const url = new URL(app.url),
    origin = url.origin;
  let headers = {};
  async function request(path, input) {
    return fetch(
      origin + path,
      input === undefined
        ? { headers }
        : {
            method: "POST",
            headers: {
              ...headers,
              Origin: origin,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          },
    );
  }
  headers = {};
  async function call(path, input) {
    const response = await request(path, input);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  return { app, agentDir, cwd, call, request };
}
test("headless SDK exposes native settings, sparse scopes and reload while preserving shared Web access", async (t) => {
  const f = await fixture(t);
  assert(
    f.app.runtime.session.sessionManager
      .getSessionDir()
      .startsWith(join(f.agentDir, "sessions") + "/"),
  );
  const initial = await f.call("/api/state");
  assert.equal(initial.host, "headless");
  assert(initial.capabilities.reload);
  const settings = await f.call("/api/settings?scope=global");
  assert(settings.groups.flatMap((group) => group.fields).length > 60);
  const proxyField = settings.groups
    .flatMap((group) => group.fields)
    .find((field) => field.key === "httpProxy");
  assert.equal(proxyField.globalOnly, true);
  assert.equal(proxyField.secret, true);
  assert.deepEqual(settings.values.httpProxy, { configured: false });
  const malformedProxy = await f.request("/api/settings", {
    scope: "global",
    revision: settings.revision,
    patch: { httpProxy: "127.0.0.1:7897" },
  });
  assert.equal(malformedProxy.status, 422);
  assert.match((await malformedProxy.json()).error, /完整的 http:\/\//);
  await f.call("/api/settings", {
    scope: "global",
    revision: settings.revision,
    patch: {
      "compaction.reserveTokens": 2000,
      defaultThinkingLevel: "low",
      defaultTools: ["read", "ls"],
      httpProxy: "http://127.0.0.1:8890",
    },
  });
  const saved = (await readDocument(join(f.agentDir, "settings.json"))).data;
  assert.deepEqual(saved.customUntouched, { keep: true });
  assert.equal(saved.compaction.keepRecentTokens, 12345);
  assert.equal(saved.compaction.reserveTokens, 2000);
  assert.equal(saved.httpProxy, "http://127.0.0.1:8890");
  assert.deepEqual(
    (await f.call("/api/settings?scope=global")).values.httpProxy,
    { configured: true },
    "the native proxy credential must never be returned to the browser",
  );
  assert.equal(
    (
      await f.request("/api/settings", {
        scope: "global",
        revision: settings.revision,
        patch: { theme: "dark" },
      })
    ).status,
    409,
  );
  const project = await f.call("/api/settings?scope=project");
  assert.equal(
    (
      await f.request("/api/settings", {
        scope: "project",
        revision: project.revision,
        patch: { httpProxy: "http://example.com" },
      })
    ).status,
    422,
  );
  await f.call("/api/settings", {
    scope: "project",
    revision: project.revision,
    patch: { "compaction.enabled": false },
  });
  assert.equal(
    (await readDocument(join(f.cwd, ".pi", "settings.json"))).data.compaction
      .enabled,
    false,
  );
  await f.call("/api/reload", {});
  const after = await f.call("/api/state");
  assert.equal(after.sessionId, initial.sessionId);
  assert.equal(after.pending, false);
  assert(after.tools.includes("ls"));
});
test("managed new/switch reuses independent slots while retaining bridge and shared access", async (t) => {
  const f = await fixture(t);
  f.app.runtime.session.setSessionName("会话 A");
  f.app.runtime.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "stored without model request" }],
    timestamp: Date.now(),
  });
  const first = await f.call("/api/state");
  await f.call("/api/new-session", {});
  const second = await f.call("/api/state");
  assert.notEqual(first.sessionId, second.sessionId);
  const list = await f.call("/api/sessions");
  assert(list.rows.some((row) => row.id === first.sessionId));
  await f.call("/api/switch-session", { id: first.sessionId });
  const restored = await f.call("/api/state");
  assert.equal(restored.sessionId, first.sessionId);
  assert(
    restored.messages.some(
      (row) => row.text === "stored without model request",
    ),
  );
  assert.equal(
    (await f.request("/api/switch-session", { id: "../../auth.json" })).status,
    404,
  );
});
test("native provider API-key login persists auth without returning the saved credential", async (t) => {
  const f = await fixture(t);
  const providers = await f.call("/api/providers");
  assert(
    !providers.rows.some((row) => row.id === "openai"),
    "Unauthenticated store providers stay out of management",
  );
  const provider = providers.catalog.find((row) => row.id === "openai");
  assert(provider.auth.apiKey);
  const start = await f.call("/api/auth-start", {
    provider: "openai",
    type: "api_key",
  });
  let job;
  for (let i = 0; i < 30; i++) {
    job = (await f.call("/api/interactions")).rows.find(
      (row) => row.id === start.id,
    );
    if (job?.prompt) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(job.prompt);
  const secret = "sk-pi-web-fixture-only";
  await f.call("/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: secret,
  });
  for (let i = 0; i < 100; i++) {
    job = (await f.call("/api/interactions")).rows.find(
      (row) => row.id === start.id,
    );
    if (job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "complete");
  const auth = JSON.parse(
    await readFile(join(f.agentDir, "auth.json"), "utf8"),
  );
  assert.equal(auth.openai.key, secret);
  const authenticated = await f.call("/api/providers");
  assert(authenticated.rows.some((row) => row.id === "openai"));
  assert(!JSON.stringify(authenticated).includes(secret));
  assert(!JSON.stringify(await f.call("/api/interactions")).includes(secret));
  await f.call("/api/auth-logout", { provider: "openai" });
  assert(
    !(await f.call("/api/providers")).rows.some((row) => row.id === "openai"),
  );
  assert(
    !JSON.parse(await readFile(join(f.agentDir, "auth.json"), "utf8")).openai,
  );
});
test("settings validation rejects malformed nested budgets and prototype keys", async (t) => {
  const f = await fixture(t);
  const doc = await f.call("/api/settings?scope=global");
  for (const patch of [
    { "compaction.reserveTokens": -1 },
    { thinkingBudgets: { high: "many" } },
    { "compaction.modelOverrides": { demo: { reserveTokens: 1.5 } } },
    { modelThinkingLevels: { demo: "impossible" } },
    JSON.parse('{"constructor.prototype":true}'),
  ])
    assert.equal(
      (
        await f.request("/api/settings", {
          scope: "global",
          revision: doc.revision,
          patch,
        })
      ).status,
      422,
    );
  assert.equal(
    (await readDocument(join(f.agentDir, "settings.json"))).revision,
    doc.revision,
  );
});
test("native package manager installs and removes a local Pi package in the selected scope", async (t) => {
  const f = await fixture(t);
  const packageDir = join(f.cwd, "test-package");
  await mkdir(packageDir);
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "fixture-package",
      version: "1.0.0",
      pi: { extensions: ["index.ts"] },
    }),
  );
  await writeFile(
    join(packageDir, "index.ts"),
    "export default function(pi) {}",
  );
  await f.call("/api/package", {
    action: "install",
    source: packageDir,
    scope: "global",
  });
  let data = (await readDocument(join(f.agentDir, "settings.json"))).data;
  assert.equal(data.packages.length, 1);
  assert.deepEqual(data.customUntouched, { keep: true });
  const plugins = await f.call("/api/plugins");
  const row = plugins.rows.find((row) => row.source === data.packages[0]);
  assert(row);
  await f.call("/api/plugin-resources", {
    id: row.id,
    revision: row.revision,
    patch: { extensions: [], skills: ["skills/*.md"] },
  });
  data = (await readDocument(join(f.agentDir, "settings.json"))).data;
  assert.deepEqual(data.packages[0].extensions, []);
  assert.deepEqual(data.packages[0].skills, ["skills/*.md"]);
  await f.call("/api/package", {
    action: "remove",
    source: packageDir,
    scope: "global",
  });
  assert.equal(
    (await readDocument(join(f.agentDir, "settings.json"))).data.packages
      .length,
    0,
  );
});
test("SDK project resources stay gated until explicitly trusted in Web", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-trust-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(
    join(cwd, ".pi", "extensions", "test.ts"),
    'export default function(pi) { pi.registerCommand("trust-fixture", {description:"test",handler:async()=>{}}); }',
  );
  const app = await startWeb({ agentDir, cwd, port: 0 });
  await app.ready;
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(app.runtime.session.settingsManager.isProjectTrusted(), false);
  assert(
    !app.runtime.session.extensionRunner
      .getRegisteredCommands()
      .some((command) => command.name === "trust-fixture"),
  );
  const url = new URL(app.url),
    origin = url.origin;
  const headers = { "Content-Type": "application/json" };
  const response = await fetch(origin + "/api/project-trust", {
    method: "POST",
    headers,
    body: JSON.stringify({ trusted: true }),
  });
  assert.equal(response.status, 200);
  assert.equal(app.runtime.session.settingsManager.isProjectTrusted(), true);
  assert(
    app.runtime.session.extensionRunner
      .getRegisteredCommands()
      .some((command) => command.name === "trust-fixture"),
  );
});
test("startup extension dialog can be completed over Web before runtime initialization settles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-startup-ui-")),
    agentDir = join(root, "agent");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "startup.ts"),
    'export default function(pi) { pi.on("session_start", async (_event,ctx) => { await ctx.ui.confirm("初始化确认", "测试启动交互"); }); }',
  );
  const app = await startWeb({ cwd: root, agentDir, port: 0 });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  const url = new URL(app.url),
    origin = url.origin;
  const headers = { "Content-Type": "application/json" };
  let job;
  for (let i = 0; i < 50; i++) {
    job = (
      await (await fetch(origin + "/api/interactions", { headers })).json()
    ).rows.find((row) => row.prompt);
    if (job) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(job);
  assert.equal(
    (await (await fetch(origin + "/api/state", { headers })).json())
      .initializing,
    true,
  );
  const reply = await fetch(origin + "/api/interaction-reply", {
    method: "POST",
    headers,
    body: JSON.stringify({ id: job.id, promptId: job.prompt.id, value: "yes" }),
  });
  assert.equal(reply.status, 200);
  await app.ready;
  assert.equal(
    (await (await fetch(origin + "/api/state", { headers })).json())
      .initializing,
    false,
  );
});
test("Web prompt drives the real Pi agent loop, read tool and native compact through a local compatible SSE endpoint", async (t) => {
  const { createServer } = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "pi-web-agent-loop-")),
    agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(root, "README.md"), "local fixture workspace");
  let requests = 0;
  const endpoint = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests++;
    const toolReturned = body.messages.some(
      (message) => message.role === "tool",
    );
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (!body.tools?.length) {
      send({
        role: "assistant",
        content: "## Goal\n读取工作区。\n## Progress\n已读取 README.md。",
      });
      send({}, "stop");
    } else if (toolReturned) {
      send({ role: "assistant", content: "已读取本地工作区。" });
      send({}, "stop");
    } else {
      send({ role: "assistant", reasoning_content: "先读取真实工作区文件。" });
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "fixture-read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: "README.md" }),
            },
          },
        ],
      });
      send({}, "tool_calls");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "fixture-model",
              reasoning: false,
              contextWindow: 16000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
      cacheWarming: "off",
      compaction: { keepRecentTokens: 1, reserveTokens: 1000 },
    }),
  );
  const app = await startWeb({
    cwd: root,
    agentDir,
    port: 0,
    noExtensions: true,
  });
  await app.ready;
  t.after(async () => {
    await app.stop();
    await new Promise((resolve) => {
      endpoint.close(resolve);
      endpoint.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  });
  const url = new URL(app.url),
    origin = url.origin;
  const headers = { "Content-Type": "application/json" };
  const sent = await fetch(origin + "/api/prompt", {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "请读取 README.md", mode: "steer" }),
  });
  assert.equal(sent.status, 200);
  for (let i = 0; i < 100; i++) {
    if (requests >= 2 && app.runtime.session.isIdle) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(requests, 2);
  const state = await (await fetch(origin + "/api/state", { headers })).json();
  assert(
    state.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "read" &&
        message.text.includes("local fixture workspace"),
    ),
  );
  assert(
    state.messages.some(
      (message) =>
        message.role === "assistant" && message.text === "已读取本地工作区。",
    ),
  );
  assert.equal(state.idle, true);
  assert(
    state.messages.some((row) =>
      row.blocks.some(
        (block) =>
          block.type === "thinking" && block.text.includes("真实工作区"),
      ),
    ),
  );
  assert(
    state.messages.some((row) =>
      row.blocks.some(
        (block) =>
          block.type === "toolCall" &&
          block.id === "fixture-read" &&
          block.arguments.includes("README.md"),
      ),
    ),
  );
  assert(
    state.activeCalls.some(
      (call) =>
        call.id === "fixture-read" &&
        call.status === "complete" &&
        call.output.includes("local fixture workspace"),
    ),
  );
  assert.equal(state.streamingMessage, null);
  const compact = await fetch(origin + "/api/prompt", {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "/compact 保留读取的文件信息" }),
  });
  assert.equal(compact.status, 200);
  for (let i = 0; i < 100; i++) {
    if (
      app.runtime.session.sessionManager
        .getBranch()
        .some((entry) => entry.type === "compaction")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(
    app.runtime.session.sessionManager
      .getBranch()
      .some((entry) => entry.type === "compaction"),
    "Web /compact must create a native Pi compaction entry",
  );
});

test("Web command catalog uses loaded Pi skills and templates and native commands do not become chat messages", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "skills", "fixture"), { recursive: true });
  await writeFile(
    join(f.agentDir, "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: Native loaded fixture skill\n---\nRead README.md.\n",
  );
  await mkdir(join(f.agentDir, "prompts"));
  await writeFile(
    join(f.agentDir, "prompts", "review.md"),
    "---\ndescription: Native loaded review prompt\n---\nReview $ARGUMENTS.\n",
  );
  await f.call("/api/reload", {});
  let state = await f.call("/api/state");
  assert(
    state.commands.some(
      (row) => row.name === "skill:fixture" && row.source === "skill",
    ),
  );
  assert(
    state.commands.some(
      (row) => row.name === "review" && row.source === "prompt",
    ),
  );
  assert(
    state.commands.some(
      (row) => row.name === "compact" && row.action === "native",
    ),
  );
  const messages = state.messages.length;
  assert(!state.commands.some((row) => row.name === "desk"));
  const desk = await f.request("/api/prompt", { message: "/desk" });
  assert.equal(desk.status, 422);
  assert((await desk.json()).error.includes("TUI"));
  assert.equal((await f.call("/api/state")).messages.length, messages);
  await f.call("/api/prompt", { message: "/name Native Web name" });
  for (let i = 0; i < 50; i++) {
    state = await f.call("/api/state");
    if (state.idle) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.name, "Native Web name");
  assert.equal(state.messages.length, messages);
  assert.equal(
    (await f.request("/api/prompt", { message: "/unknown-command" })).status,
    422,
  );
  const settings = await f.call("/api/settings?scope=global");
  await f.call("/api/settings", {
    scope: "global",
    revision: settings.revision,
    patch: { enableSkillCommands: false },
  });
  await f.call("/api/reload", {});
  state = await f.call("/api/state");
  assert(!state.commands.some((row) => row.source === "skill"));
});

test("Web skill toggles use Pi native resource filters and survive reload, including package skills", async (t) => {
  const f = await fixture(t);
  const skillDir = join(f.agentDir, "skills", "switch-fixture");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: switch-fixture\ndescription: Native disable test\n---\nUse read.\n",
  );
  await f.call("/api/reload", {});
  let row = (await f.call("/api/skills")).rows.find(
    (row) => row.name === "switch-fixture",
  );
  assert(row?.enabled);
  await f.call("/api/skill", {
    id: row.id,
    revision: row.revision,
    enabled: false,
  });
  row = (await f.call("/api/skills")).rows.find(
    (row) => row.name === "switch-fixture",
  );
  assert.equal(row.enabled, false);
  await f.call("/api/reload", {});
  assert(
    !f.app.runtime.session.resourceLoader
      .getSkills()
      .skills.some((skill) => skill.name === "switch-fixture"),
  );
  await f.call("/api/skill", {
    id: row.id,
    revision: row.revision,
    enabled: true,
  });
  await f.call("/api/reload", {});
  assert(
    f.app.runtime.session.resourceLoader
      .getSkills()
      .skills.some((skill) => skill.name === "switch-fixture"),
  );
  const pkg = join(f.cwd, "skill-package");
  await mkdir(join(pkg, "skills", "package-switch"), { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "skill-package",
      version: "1.0.0",
      pi: { skills: ["./skills"] },
    }),
  );
  await writeFile(
    join(pkg, "skills", "package-switch", "SKILL.md"),
    "---\nname: package-switch\ndescription: Package skill toggle test\n---\nRead.\n",
  );
  await f.call("/api/package", {
    action: "install",
    source: pkg,
    scope: "global",
  });
  await f.call("/api/reload", {});
  row = (await f.call("/api/skills")).rows.find(
    (row) => row.name === "package-switch",
  );
  assert(row?.enabled);
  await f.call("/api/skill", {
    id: row.id,
    revision: row.revision,
    enabled: false,
  });
  await f.call("/api/reload", {});
  assert(
    !f.app.runtime.session.resourceLoader
      .getSkills()
      .skills.some((skill) => skill.name === "package-switch"),
  );
  row = (await f.call("/api/skills")).rows.find(
    (row) => row.name === "package-switch",
  );
  assert.equal(row.enabled, false);
  await f.call("/api/skill", {
    id: row.id,
    revision: row.revision,
    enabled: true,
  });
  await f.call("/api/reload", {});
  assert(
    f.app.runtime.session.resourceLoader
      .getSkills()
      .skills.some((skill) => skill.name === "package-switch"),
  );
  assert.deepEqual(
    (await readDocument(join(f.agentDir, "settings.json"))).data
      .customUntouched,
    { keep: true },
  );
});

test("Web manages and discovers an actual stdio MCP server through Pi native extension", async (t) => {
  const f = await fixture(t, { noExtensions: false });
  const server = join(f.cwd, "mcp-fixture.mjs");
  await writeFile(
    server,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 let result={};
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local-fixture',version:'1.0'}};
 if(request.method==='tools/list')result={tools:[{name:'echo',description:'Local fixture tool',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
 if(request.method==='tools/call')result={content:[{type:'text',text:request.params.arguments?.text ?? 'native MCP'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});`,
  );
  let inventory = await f.call("/api/mcp");
  await f.call("/api/mcp", {
    action: "save",
    name: "local-fixture",
    scope: "global",
    revision: inventory.revisions.global,
    config: {
      command: process.execPath,
      args: [server],
      exposure: "direct",
      env: { PRIVATE_TEST: "keep-this-private" },
    },
  });
  await f.call("/api/reload", {});
  for (let i = 0; i < 80; i++) {
    inventory = await f.call("/api/mcp");
    if (
      inventory.rows.find((row) => row.name === "local-fixture")?.tools.length
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  let row = inventory.rows.find((row) => row.name === "local-fixture");
  assert.equal(row.tools[0]?.name, "mcp__local_fixture__echo");
  assert(!JSON.stringify(inventory).includes("keep-this-private"));
  const result = await f.app.runtime.session
    .getToolDefinition("mcp__local_fixture__echo")
    .execute(
      "web-mcp-test",
      { text: "Pi owns this connection" },
      new AbortController().signal,
      () => {},
    );
  assert(
    result.content.some((block) => block.text === "Pi owns this connection"),
  );
  const job = await f.call("/api/mcp-action", { action: "status" });
  for (let i = 0; i < 40; i++) {
    const current = (await f.call("/api/interactions")).rows.find(
      (row) => row.id === job.id,
    );
    if (current.status === "complete") {
      assert(
        current.events.some((event) =>
          event.message.includes("local-fixture: connected"),
        ),
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await f.call("/api/mcp", {
    action: "save",
    name: row.name,
    scope: row.scope,
    revision: row.revision,
    config: { description: "updated", env: { PRIVATE_TEST: "" } },
  });
  assert.equal(
    (await readDocument(join(f.agentDir, "mcp.json"))).data.mcpServers[
      "local-fixture"
    ].env.PRIVATE_TEST,
    "keep-this-private",
  );
  inventory = await f.call("/api/mcp");
  row = inventory.rows.find((row) => row.name === "local-fixture");
  await f.call("/api/mcp", {
    action: "toggle",
    name: row.name,
    scope: row.scope,
    revision: row.revision,
    enabled: false,
  });
  await f.call("/api/reload", {});
  assert(
    !f.app.runtime.session
      .getAllTools()
      .some((tool) => tool.name === "mcp__local_fixture__echo"),
  );
  inventory = await f.call("/api/mcp");
  row = inventory.rows.find((row) => row.name === "local-fixture");
  await f.call("/api/mcp", {
    action: "remove",
    name: row.name,
    scope: row.scope,
    revision: row.revision,
  });
  assert(
    !(await f.call("/api/mcp")).rows.some(
      (row) => row.name === "local-fixture",
    ),
  );
  const rejected = await f.request("/api/mcp", {
    action: "save",
    name: "unsafe",
    scope: "project",
    revision: (await f.call("/api/mcp")).revisions.project,
    config: {
      url: "https://example.invalid/mcp",
      auth: { provider: "fixture" },
    },
  });
  assert.equal(rejected.status, 422);
});
