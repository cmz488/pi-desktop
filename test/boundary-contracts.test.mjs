import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  HOST_CAPABILITY_KEYS,
  createHostInterface,
  normalizeHostCapabilities,
} from "../src/server/host-interface.mjs";
import {
  createDurableRuntime,
  defineAgentRuntime,
  defaultAgentRuntime,
} from "../src/control-plane/agent-runtime.mjs";
import { embeddedSdkEntry } from "../src/agent/pi-sdk.mjs";

/* These tests pin the interfaces documented in docs/architecture/interfaces/.
 * A rename or a removal in the implementation must fail here, so the document
 * and the code cannot drift apart silently. Behaviour-heavy paths (worker boot,
 * resource Session) stay in their integration suites; this file guards shape. */

const repo = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(repo, path), "utf8");
const slice = (source, from, to) => {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `expected to find ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `expected to find ${to} after ${from}`);
  return source.slice(start, end);
};

test("the Host interface keeps its declared capability set", () => {
  assert.equal(HOST_CAPABILITY_KEYS.length, 39);
  assert.deepEqual([...HOST_CAPABILITY_KEYS].sort(), [
    "abort",
    "auth",
    "authLogout",
    "btw",
    "canDeferConfiguration",
    "canEditShared",
    "canManageSessions",
    "canSaveSettings",
    "canSetThinking",
    "canWrite",
    "gitChanged",
    "interactions",
    "mcp",
    "model",
    "newSession",
    "packageManagement",
    "packageRoot",
    "packageUpdates",
    "projectTrusted",
    "prompt",
    "providerCatalog",
    "providerInventory",
    "providerRemove",
    "providerSave",
    "reload",
    "remote",
    "requestContext",
    "revision",
    "route",
    "sessionCommand",
    "sessionTree",
    "sessions",
    "settings",
    "settingsChanged",
    "skills",
    "switchSession",
    "thinking",
    "trustProject",
    "validateTarget",
  ]);
  const capabilities = normalizeHostCapabilities({
    prompt: true,
    gitChanged: 1,
  });
  assert.equal(Object.keys(capabilities).length, 39);
  assert.equal(capabilities.prompt, true);
  assert.equal(capabilities.gitChanged, false, "only true counts as enabled");
  assert.equal(capabilities.abort, false);
  assert.throws(
    () => normalizeHostCapabilities({ nope: true }),
    /未知的 Host capability/,
  );
  assert.throws(() => createHostInterface({}), /Host 必须提供 snapshot/);
});

test("the request target token rejects a changed session, cwd or readiness", async () => {
  const state = { sessionId: "A", cwd: "/project" };
  const host = createHostInterface({
    snapshot: () => state,
    capabilities: { prompt: true, validateTarget: true },
    prompt: async () => "ok",
    validateTarget: () => {},
  });
  assert.throws(
    () => host.target({ sessionId: "B" }),
    (error) => error.status === 409,
  );
  const target = host.target({ sessionId: "A" });
  assert.equal(target.cwd, "/project");
  state.cwd = "/other";
  assert.throws(
    () => target.assert(),
    (error) => error.status === 409,
  );
  state.cwd = "/project";
  state.sessionId = "B";
  assert.throws(
    () => target.assert(),
    (error) => error.status === 409,
  );
  state.sessionId = "A";
  state.initializing = true;
  assert.throws(() => target.assert({ ready: true }), /初始化/);
  delete state.initializing;
  assert.throws(
    () => host.target({}).assertInput({ requireSession: true }),
    (error) => error.status === 409,
  );
  assert.equal(target.assert({ ready: true }).cwd, "/project");
  assert.equal(await host.require("prompt")(), "ok");
  assert.throws(
    () => host.require("abort"),
    (error) => error.status === 501,
  );
});

test("the Agent runtime seam keeps its shape and its fixed durable options", async () => {
  assert.throws(() => defineAgentRuntime({ start() {} }), /id/);
  assert.throws(() => defineAgentRuntime({ id: " " }), /id/);
  assert.throws(() => defineAgentRuntime({ id: "x" }), /start/);
  assert.equal(defaultAgentRuntime.id, "durable");
  let received;
  const runtime = createDurableRuntime({
    start: async (options) => {
      received = options;
      return { url: "http://127.0.0.1:1" };
    },
  });
  await runtime.start({ cwd: "/tmp/project", readOnly: true });
  assert.deepEqual(received, {
    cwd: "/tmp/project",
    readOnly: true,
    singleAgent: true,
    host: "127.0.0.1",
    port: 0,
  });
  const process = read("src/control-plane/process.mjs");
  assert.match(
    process,
    /launchService\(entry, options, \{ timeout = 45000 \} = \{\}\)/,
  );
  assert.match(process, /type: "ready"/);
  assert.match(process, /child\.kill\("SIGTERM"\), 8000/);
  assert.match(process, /child\.kill\("SIGKILL"\), 10000/);
});

test("the pi-sdk adapter keeps its deep compatibility paths and exports", async () => {
  const source = read("src/agent/pi-sdk.mjs");
  const paths = [
    ...new Set([...source.matchAll(/"\.\/([a-z/.-]+\.js)"/g)].map((m) => m[1])),
  ].sort();
  assert.deepEqual(paths, [
    "core/auth-storage.js",
    "core/http-dispatcher.js",
    "core/messages.js",
    "core/prompt-templates.js",
    "core/session-manager.js",
    "core/settings-manager.js",
    "extensions/mcp/oauth.js",
  ]);
  for (const path of paths) {
    const file = fileURLToPath(new URL(`./${path}`, embeddedSdkEntry));
    assert.equal(
      (await stat(file).catch(() => null))?.isFile(),
      true,
      `${path} exists`,
    );
  }
  const { loadPiSettingsManager, loadPiSessionManager, loadPiMessages } =
    await import("../src/agent/pi-sdk.mjs");
  const settings = await loadPiSettingsManager();
  assert.equal(typeof settings.SettingsManager, "function");
  const sessions = await loadPiSessionManager();
  assert.equal(typeof sessions.SessionManager, "function");
  assert.equal(typeof sessions.buildSessionProjection, "function");
  const messages = await loadPiMessages();
  assert.equal(typeof messages.convertToLlm, "function");
  for (const name of [
    "SettingsManager",
    "SessionManager",
    "getAgentDir",
    "createAgentSessionRuntime",
    "createCodemodeExtension",
    "createToolSearchExtension",
    "createMcpExtension",
    "ProjectTrustStore",
    "loadSkills",
    "Theme",
  ])
    assert.match(
      source,
      new RegExp(`"${name}"`),
      `checkPiSdk requires ${name}`,
    );
});

test("the workspace, resources facade and supervisor keep their declared keys", () => {
  const workspace = read("src/agent/agent-workspace.mjs");
  const workspaceBody = slice(workspace, "const workspace = {", "  try {");
  for (const key of [
    "read",
    "live",
    "agent",
    "execute",
    "install",
    "subscribe",
    "close",
    "transcript",
    "persistNative",
    "importNative",
  ])
    assert.match(
      workspaceBody,
      new RegExp(`^    (async )?${key}[,:(]`, "m"),
      `workspace.${key}`,
    );
  for (const command of [
    "create",
    "send",
    "abort",
    "compact",
    "configure",
    "fork",
  ])
    assert.match(
      workspace,
      new RegExp(`command === "${command}"`),
      `execute ${command}`,
    );

  const resources = read("src/agent/durable-resources.mjs");
  const resourcesBody = slice(resources, "  return {\n    attach,", "  };\n}");
  for (const key of [
    "attach",
    "ensure",
    "normalizeExtensions",
    "selectTools",
    "reload",
    "close",
    "cancelInteractions",
    "canWrite",
  ])
    assert.match(
      resourcesBody,
      new RegExp(`^    ${key}[,:]`, "m"),
      `resources.${key}`,
    );
  for (const action of [
    "approvalMode",
    "expandPrompt",
    "packageAction",
    "interactions.",
    "settingsChanged",
    "skillInventory",
    "mcpRegistered",
    "mcpTools",
    "mcpAction",
    "trustProject",
    "packageRoot",
    "packageUpdates",
  ])
    assert.match(
      resources,
      new RegExp(`"${action.replace(/\./g, "\\.")}`),
      `action ${action}`,
    );

  const native = read("src/agent/native-runtime.mjs");
  const nativeBody = slice(
    native,
    "  return {\n    record: mirror,",
    "  };\n}",
  );
  for (const key of [
    "record",
    "bind",
    "flush",
    "beforeRequest",
    "afterResponse",
    "afterTools",
    "dispose",
  ])
    assert.match(
      nativeBody,
      new RegExp(`^    (async )?${key}[,:(]`, "m"),
      `native.${key}`,
    );

  const supervisor = read("src/control-plane/supervisor.mjs");
  const supervisorBody = slice(
    supervisor,
    "  return {\n    shared(run) {",
    "\n  };\n}",
  );
  for (const key of [
    "shared",
    "noteActivity",
    "revision",
    "read",
    "execute",
    "target",
    "openTarget",
    "restore",
    "close",
  ])
    assert.match(
      supervisorBody,
      new RegExp(`^    (async )?${key}\\(`, "m"),
      `supervisor.${key}`,
    );
  for (const command of [
    "project.save",
    "project.rename",
    "project.remove",
    "agent.save",
    "agent.rename",
    "agent.policy",
    "agent.prompt",
    "agent.pin",
    "agent.archive",
    "agent.restore",
    "agent.resume",
    "conversation.create",
    "prompt.save",
  ])
    assert.match(
      supervisor,
      new RegExp(`"${command.replace(/\./g, "\\.")}"`),
      `command ${command}`,
    );
});

test("the boundary and interface documents stay present and linked", () => {
  const documents = [
    "docs/architecture/pi-boundary.md",
    "docs/architecture/interfaces/README.md",
    "docs/architecture/interfaces/host-interface.md",
    "docs/architecture/interfaces/agent-runtime.md",
    "docs/architecture/interfaces/durable-workspace.md",
    "docs/architecture/interfaces/resource-session.md",
    "docs/architecture/interfaces/pi-sdk-adapter.md",
    "docs/architecture/interfaces/lifecycle.md",
    "docs/guides/code-style.md",
  ];
  for (const document of documents)
    assert.ok(read(document).includes("#"), `${document} is a document`);
  assert.match(read("docs/README.md"), /architecture\/pi-boundary\.md/);
  assert.match(read("docs/README.md"), /architecture\/interfaces\/README\.md/);
  assert.match(read("docs/README.md"), /guides\/code-style\.md/);
  assert.match(read("docs/architecture/source-map.md"), /pi-boundary\.md/);
  assert.match(read("docs/architecture/source-map.md"), /code-style\.md/);
  assert.match(
    read("docs/architecture/verification.md"),
    /guides\/code-style\.md/,
  );
  assert.match(
    read("docs/architecture/pi-boundary.md"),
    /interfaces\/README\.md/,
  );
});
