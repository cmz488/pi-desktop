import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { startDesktopHost } from "../src/control-plane/server.mjs";
import { launchService } from "../src/control-plane/process.mjs";
import { readUntil } from "./sse-reader.mjs";

test("workspace page loads its first-paint theme bootstrap as a same-origin script", async (t) => {
  // CSP 是 script-src 'self'：内联脚本会被拦截，外壳就会先按浅色绘制。
  const f = await desktopFixture();
  t.after(() => f.close());
  const response = await fetch(new URL("/", f.app.url));
  assert.match(
    response.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  const html = await response.text();
  assert(html.includes('<script src="workspace-boot.js"></script>'));
  assert(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), "HTML 不能依赖内联脚本");
  const boot = await fetch(new URL("/workspace-boot.js", f.app.url));
  assert.equal(boot.status, 200);
  assert.match(boot.headers.get("content-type"), /javascript/);
});

test("workspace browser module imports are served without starting an Agent", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const pending = [new URL("/workspace.js", f.app.url)];
  const visited = new Set();
  while (pending.length) {
    const url = pending.pop();
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const response = await fetch(url);
    assert.equal(
      response.status,
      200,
      `browser import is missing: ${url.pathname}`,
    );
    assert.match(response.headers.get("content-type"), /javascript/);
    const source = await response.text();
    for (const [, specifier] of source.matchAll(
      /\b(?:from\s*|import\s*)["'](\.[^"']+)["']/g,
    )) {
      pending.push(new URL(specifier, url));
    }
  }
  assert(visited.has(new URL("/extension-adapters.mjs", f.app.url).href));
  assert.equal((await f.call("/api/workspace")).agents.length, 0);
});

test("a service spawn failure rejects and finishes cleanup instead of leaving a pending process", async () => {
  const service = launchService("/tmp/no-such-pi-worker.mjs", {
    cwd: "/tmp/no-such-pi-worker-directory",
  });
  await assert.rejects(service.ready);
  await service.stop();
});

test(
  "multi-project desktop owns independent Pi processes, injects native resources, proxies streams and restores SQLite conversations",
  { timeout: 60000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    let catalog = await f.call("/api/workspace");
    const project = catalog.projects[0];
    await f.command("project.save", {
      id: project.id,
      cwd: f.cwd,
      name: "Project A",
    });
    await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT_INSTRUCTION");
    const globalSettings = JSON.parse(
      await readFile(join(f.agentDir, "settings.json"), "utf8"),
    );
    Object.assign(globalSettings, {
      extensions: [join(f.cwd, "extension.mjs")],
      skills: [join(f.cwd, "skills")],
      prompts: [join(f.cwd, "prompts")],
    });
    await writeFile(
      join(f.agentDir, "settings.json"),
      JSON.stringify(globalSettings),
    );
    const persona = await f.command("prompt.save", {
      name: "Agent A persona",
      instructions: "AGENT_A_INSTRUCTION",
    });
    const other = await f.command("project.save", {
      cwd: f.other,
      name: "Project B",
    });
    const a = await f.command("agent.save", {
      projectId: project.id,
      name: "Agent A",
      promptProfileId: persona.id,
    });
    const b = await f.command("agent.save", {
      projectId: project.id,
      name: "Agent B",
    });
    const c = await f.command("agent.save", {
      projectId: other.id,
      name: "Agent C",
    });
    await Promise.all(
      [a, b, c].map((agent) => f.command("agent.start", { id: agent.id })),
    );
    catalog = await f.call("/api/workspace");
    assert.equal(new Set(catalog.agents.map((row) => row.pid)).size, 3);
    assert(catalog.agents.every((row) => row.status === "running"));
    await assert.rejects(
      startDesktopHost({ agentDir: f.agentDir, directory: f.directory }),
      /占用/,
    );
    const stateA = await f.call(`/agents/${a.id}/api/state`);
    const stateB = await f.call(`/agents/${b.id}/api/state`);
    const stateC = await f.call(`/agents/${c.id}/api/state`);
    assert.equal(stateA.cwd, f.cwd);
    assert.equal(stateC.cwd, f.other);
    const descriptorA = await f.call(`/agents/${a.id}/api/agent`);
    const descriptorB = await f.call(`/agents/${b.id}/api/agent`);
    assert(JSON.stringify(descriptorA).includes("fixture_marker"));
    assert(JSON.stringify(descriptorB).includes("fixture_marker"));
    const origin = new URL(f.app.url).origin;
    const html = await fetch(`${origin}/agents/${a.id}/?embed=1`);
    assert.match(
      html.headers.get("content-security-policy"),
      /frame-ancestors 'self'/,
    );
    assert.equal(
      (await fetch(`${origin}/agents/${a.id}/prototype.js`)).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${origin}/agents/${a.id}/fonts/DepartureMono-Regular.woff2`,
        )
      ).status,
      200,
    );
    await assert.rejects(
      f.command("agent.save", { id: a.id, name: "changed" }),
      /停止/,
    );
    await assert.rejects(
      f.command("project.save", { id: project.id, cwd: f.cwd }),
      /停止/,
    );
    await assert.rejects(
      f.call(`/agents/${a.id}/api/command`, {
        command: "create",
        cwd: f.other,
      }),
      /项目栏/,
    );
    await assert.rejects(
      f.command("agent.stop", { id: a.id, revision: "stale" }),
      (error) => error.status === 409,
    );
    const hostile = await fetch(origin + "/api/workspace/command", {
      method: "POST",
      headers: {
        Origin: "https://evil.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "agent.stop", id: a.id }),
    });
    assert.equal(hostile.status, 403);
    // A protocol-relative proxy path must still target the owned local worker.
    const malicious = await fetch(
      `${origin}/agents/${a.id}//example.invalid/api/state`,
    );
    assert.equal(malicious.status, 404);
    const controller = new AbortController();
    const stream = await fetch(`${origin}/agents/${a.id}/api/events`, {
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    assert(
      (await readUntil(reader, "resync_required")).includes("resync_required"),
    );
    controller.abort();
    await Promise.all([
      f.call(`/agents/${a.id}/api/prompt`, {
        message: "/fixture-template hello A",
        sessionId: stateA.sessionId,
        requestId: "test-A",
      }),
      f.call(`/agents/${c.id}/api/prompt`, {
        message: "hello C",
        sessionId: stateC.sessionId,
        requestId: "test-C",
      }),
    ]);
    const answered = await until(
      () => f.call(`/agents/${a.id}/api/state`),
      (value) =>
        value.idle && value.messages.some((row) => row.role === "assistant"),
    );
    assert(
      answered.messages.some((row) =>
        row.text.includes("Template fixture: hello"),
      ),
    );
    const requestA = f.requests.find((row) =>
      JSON.stringify(row).includes("PROJECT_INSTRUCTION"),
    );
    assert(JSON.stringify(requestA).includes("AGENT_A_INSTRUCTION"));
    assert(JSON.stringify(requestA).includes("fixture-skill"));
    assert(
      !JSON.stringify(
        f.requests.find((row) => JSON.stringify(row).includes("hello C")),
      ).includes("PROJECT_INSTRUCTION"),
    );
    const unaffected = catalog.agents.find((row) => row.id === c.id).pid;
    await f.command("agent.stop", { id: b.id });
    assert.equal(
      (await f.call("/api/workspace")).agents.find((row) => row.id === c.id)
        .pid,
      unaffected,
    );
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.filter((row) => row.status === "running").length === 2,
    );
    assert.equal(
      (await f.call("/api/workspace")).agents.find((row) => row.id === b.id)
        .status,
      "stopped",
    );
    const restored = await f.call(`/agents/${a.id}/api/state`);
    assert.deepEqual(restored.messages, answered.messages);
    assert(
      (await readFile(join(f.directory, "agents", a.id, "agents.sqlite")))
        .length > 0,
    );
    await f.command("agent.stop", { id: a.id });
    await f.command("agent.save", {
      id: a.id,
      name: "Renamed",
    });
    await f.command("prompt.save", {
      id: persona.id,
      name: "Agent A persona",
      instructions: "UPDATED_INSTRUCTION",
    });
    await f.command("agent.start", { id: a.id });
    await f.call(`/agents/${a.id}/api/prompt`, {
      message: "updated",
      sessionId: restored.sessionId,
      requestId: "updated",
    });
    await until(
      () => f.call(`/agents/${a.id}/api/state`),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text.includes("answer: updated")),
    );
    assert(JSON.stringify(f.requests.at(-1)).includes("UPDATED_INSTRUCTION"));
    assert(!JSON.stringify(f.requests.at(-1)).includes("AGENT_A_INSTRUCTION"));
  },
);

test(
  "composer accounting separates latest context from durable cumulative tokens and survives a worker restart",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture({ defaultConversation: true });
    t.after(() => f.close());
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.projectId === null && row.status === "running",
        ),
    );
    const agent = catalog.agents.find((row) => row.projectId === null);
    const path = `/agents/${agent.id}/api/state`;
    const first = await f.call(path);
    for (const message of ["usage one", "usage two"]) {
      await f.call(`/agents/${agent.id}/api/prompt`, {
        message,
        sessionId: first.sessionId,
        requestId: message,
      });
      await until(
        () => f.call(path),
        (value) =>
          value.idle &&
          value.messages.some(
            (row) =>
              row.role === "assistant" && row.text === `answer: ${message}`,
          ),
      );
    }
    const state = await f.call(path);
    assert.deepEqual(state.metrics, {
      total: 2464,
      input: 600,
      output: 64,
      cacheRead: 1800,
      cacheWrite: 0,
      cacheHitRate: 0.75,
      cost: 0,
    });
    assert.equal(state.usage.tokens, 1232);
    assert.equal(state.usage.contextWindow, 8192);
    assert.equal(state.usage.estimated, false);
    assert.equal(state.usage.percent, (1232 / 8192) * 100);
    await f.command("agent.restart", { id: agent.id });
    const restored = await f.call(path);
    assert.deepEqual(restored.metrics, state.metrics);
    assert.deepEqual(restored.usage, state.usage);
  },
);

test(
  "Pi settings save during an active request and auto-apply after all Agents become idle",
  { timeout: 30000 },
  async (t) => {
    let releaseResponse;
    let markModelStarted;
    const modelStarted = new Promise((resolve) => {
      markModelStarted = resolve;
    });
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve;
    });
    const f = await desktopFixture({
      defaultConversation: true,
      beforeModelResponse: async () => {
        markModelStarted();
        await responseGate;
      },
    });
    t.after(async () => {
      releaseResponse();
      await f.close();
    });
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.projectId === null && row.status === "running",
        ),
    );
    const agent = catalog.agents.find((row) => row.projectId === null);
    const base = `/agents/${agent.id}/api`;
    const state = await f.call(`${base}/state`);
    await f.call(`${base}/prompt`, {
      message: "hold while settings are saved",
      sessionId: state.sessionId,
      requestId: "settings-during-run",
    });
    await modelStarted;
    assert.equal((await f.call(`${base}/state`)).idle, false);
    const settings = await f.call(`${base}/settings?scope=global`);
    await f.call(`${base}/settings`, {
      scope: "global",
      revision: settings.revision,
      patch: { defaultThinkingLevel: "low" },
    });
    assert.equal(
      JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"))
        .defaultThinkingLevel,
      "low",
    );
    assert.equal((await f.call(`${base}/state`)).pending, true);

    releaseResponse();
    const applied = await until(
      () => f.call(`${base}/state`),
      (value) => value.idle && !value.pending,
    );
    assert.equal(applied.pending, false);
    assert.equal(applied.idle, true);
  },
);

test("session metadata, permission tier and prompt selection persist through archive and worker restart", async (t) => {
  const f = await desktopFixture({ defaultConversation: true });
  t.after(() => f.close());
  const catalog = await until(
    () => f.call("/api/workspace"),
    (value) => value.agents[0]?.status === "running",
  );
  const id = catalog.agents[0].id;
  await f.command("agent.policy", { id, mode: "yolo" });
  await assert.rejects(
    f.command("agent.policy", { id, mode: "invalid" }),
    (error) => error.status === 422,
  );
  await f.command("agent.rename", { id, name: "Renamed conversation" });
  await f.command("agent.pin", { id });
  const prompt = await f.command("prompt.save", {
    name: "Review",
    instructions: "DESKTOP_SELECTED_PROMPT",
  });
  await f.command("agent.prompt", { id, promptProfileId: prompt.id });
  let actual = (await f.call(`/agents/${id}/api/agent`)).active;
  assert.equal(actual.name, "Renamed conversation");
  assert.equal(actual.instructions, "DESKTOP_SELECTED_PROMPT");
  const beforeActivity = (await f.call("/api/workspace")).agents.find(
    (row) => row.id === id,
  ).updatedAt;
  await f.call(`/agents/${id}/api/prompt`, {
    message: "Verify system prompt",
    requestId: "prompt-selection",
  });
  await until(
    () => f.call(`/agents/${id}/api/state`),
    (value) =>
      value.idle && value.messages.some((row) => row.role === "assistant"),
  );
  assert(JSON.stringify(f.requests.at(-1)).includes("DESKTOP_SELECTED_PROMPT"));
  await until(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === id).updatedAt !== beforeActivity,
  );
  await assert.rejects(f.command("agent.archive", { id }), /先停止进程/);
  await f.command("agent.stop", { id });
  await f.command("agent.archive", { id });
  await assert.rejects(f.command("agent.start", { id }), /恢复/);
  await f.reopen();
  const archived = (await f.call("/api/workspace")).agents.find(
    (row) => row.id === id,
  );
  assert.equal(archived.archived, true);
  assert.equal(archived.pinned, true);
  assert.equal(archived.approvalMode, "yolo");
  assert.equal(archived.status, "stopped");
  await f.command("agent.restore", { id });
  await f.command("agent.start", { id });
  actual = (await f.call(`/agents/${id}/api/agent`)).active;
  assert.equal(actual.instructions, "DESKTOP_SELECTED_PROMPT");
  assert.equal(actual.name, "Renamed conversation");
  assert.deepEqual(actual.tools.sort(), [
    "agent_browser",
    "read",
    "web_fetch",
    "web_search",
  ]); // YOLO does not grant projectless writes
  await f.command("agent.prompt", { id, promptProfileId: "standard" });
  assert.equal(
    (await f.call(`/agents/${id}/api/agent`)).active.instructions,
    "",
  );
});
