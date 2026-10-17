import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  MemoryStorage,
  defineExtension,
  defineTool,
  Harness,
  createRegistry,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";

export async function workspaceFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-desk-"));
  const cwd = join(directory, "one"),
    other = join(directory, "two");
  await mkdir(cwd);
  await mkdir(other);
  const models = createModels();
  const faux = fauxProvider({
    provider: "desk-test",
    models: [{ id: "local", reasoning: true }],
    tokensPerSecond: 10000,
  });
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
    ...options,
  });
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const create = (path = cwd, extra = {}) =>
    workspace.execute("create", {
      cwd: path,
      name: "Agent",
      model: { provider: "desk-test", modelId: "local" },
      ...extra,
    });
  return { directory, cwd, other, workspace, faux, models, create };
}
async function settled(workspace, id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await workspace.read(id);
    if (
      state.active.idle &&
      state.active.messages.some((row) => row.role === "assistant")
    )
      return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("conversation did not settle");
}

test("legacy native custom context is repaired before reads, resumes and forks without rewriting its history", async (t) => {
  const f = await workspaceFixture(t);
  const storagePath = join(f.directory, "legacy-native.sqlite");
  let workspace = await openAgentWorkspace({ storagePath, models: f.models });
  t.after(() => workspace.close());
  const { id } = await workspace.execute("create", {
    cwd: f.cwd,
    model: { provider: "desk-test", modelId: "local" },
  });
  await workspace.close();
  const seed = await Harness.open(
    await openNodeSqliteStorage(storagePath),
    { models: f.models, registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const custom = {
    role: "custom",
    customType: "fixture-old-notice",
    content: "legacy notice",
    display: true,
    details: { piDesktop: { version: 1, title: "Legacy card" } },
    timestamp: 1,
  };
  const original = await seed.commit(
    (tx) =>
      tx.appendEntry(id, {
        kind: "desk.native-import",
        model: [custom],
        data: { nativeSessionId: "old-session", nativeEntryId: "old-entry" },
      }),
    BACKGROUND_CONTEXT,
  );
  await seed.close(BACKGROUND_CONTEXT);
  workspace = await openAgentWorkspace({ storagePath, models: f.models });
  assert.equal(
    (await workspace.read(id)).active.messages[0].extensionView.title,
    "Legacy card",
  );
  const repaired = (await workspace.transcript(id)).entries;
  assert.deepEqual(
    repaired.find((entry) => entry.id === original.id),
    original,
  );
  assert.equal(
    repaired.filter((entry) =>
      entry.edits?.some((edit) => edit.target === original.id),
    ).length,
    1,
  );
  const fork = await workspace.execute("fork", { id, entryId: original.id });
  for (const target of [id, fork.id]) {
    f.faux.setResponses([fauxAssistantMessage(`resumed ${target}`)]);
    await workspace.execute("send", {
      id: target,
      message: "continue",
      requestId: `legacy-${target}`,
    });
    assert.equal(
      (await settled(workspace, target)).active.messages.at(-1).text,
      `resumed ${target}`,
    );
  }
  await workspace.close();
  workspace = await openAgentWorkspace({ storagePath, models: f.models });
  assert.equal(
    (await workspace.transcript(id)).entries.filter((entry) =>
      entry.edits?.some((edit) => edit.target === original.id),
    ).length,
    1,
  );
});

test("independent project agents run concurrently, submit idempotently and preserve target ownership", async (t) => {
  const f = await workspaceFixture(t);
  const a = await f.create(),
    b = await f.create(f.other);
  f.faux.setResponses([
    fauxAssistantMessage("answer A"),
    fauxAssistantMessage("answer B"),
  ]);
  const input = { id: a.id, message: "question A", requestId: "same-request" };
  const [first, again, second] = await Promise.all([
    f.workspace.execute("send", input),
    f.workspace.execute("send", input),
    f.workspace.execute("send", {
      id: b.id,
      message: "question B",
      requestId: "other-request",
    }),
  ]);
  assert.equal(first.submissionId, again.submissionId);
  assert.notEqual(first.submissionId, second.submissionId);
  const [one, two] = await Promise.all([
    settled(f.workspace, a.id),
    settled(f.workspace, b.id),
  ]);
  assert.equal(one.active.cwd, f.cwd);
  assert.equal(two.active.cwd, f.other);
  assert.equal(
    one.active.messages.filter((row) => row.role === "user").length,
    1,
  );
  assert(!two.active.messages.some((row) => row.text === "question A"));
  await assert.rejects(
    f.workspace.execute("send", { ...input, id: 999999 }),
    /不存在/,
  );
  await assert.rejects(
    f.workspace.execute("create", { cwd: join(f.directory, "missing") }),
    /目录/,
  );
});

test("native coding tools run in the selected execution environment and enforce selected tool names", async (t) => {
  const f = await workspaceFixture(t);
  await writeFile(join(f.other, "only-here.txt"), "project two");
  const agent = await f.create(f.other, { tools: ["read", "write"] });
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "read-call",
          name: "read",
          arguments: { path: "only-here.txt" },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "write-call",
          name: "write",
          arguments: { path: "result.txt", content: "stored in two" },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await f.workspace.execute("send", {
    id: agent.id,
    message: "read and write",
    requestId: "tools",
  });
  const result = await settled(f.workspace, agent.id);
  assert.equal(
    await readFile(join(f.other, "result.txt"), "utf8"),
    "stored in two",
  );
  assert(
    result.active.messages.some(
      (row) => row.role === "toolResult" && row.text.includes("project two"),
    ),
  );
  assert.deepEqual(result.active.tools.sort(), ["read", "write"]);
  await assert.rejects(
    f.workspace.execute("configure", { id: agent.id, tools: ["missing-tool"] }),
    /工具/,
  );
});

test("registry replacement changes the next call through the workspace interface", async (t) => {
  const extension = (text) =>
    defineExtension({
      name: "example",
      tools: [
        defineTool({
          name: "example",
          description: "Return registered value",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ content: [{ type: "text", text }] }),
        }),
      ],
    });
  const f = await workspaceFixture(t, { extensions: [extension("before")] });
  const a = await f.create();
  f.workspace.install(extension("after"));
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "example-call",
          name: "example",
          arguments: {},
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await f.workspace.execute("send", {
    id: a.id,
    message: "invoke example",
    requestId: "registered-tool",
  });
  assert(
    (await settled(f.workspace, a.id)).active.messages.some(
      (row) => row.role === "toolResult" && row.text === "after",
    ),
  );
});

test("SQLite persists agent choices, transcript and request IDs and refuses a second owner", async (t) => {
  const f = await workspaceFixture(t);
  const storagePath = join(f.directory, "desk.sqlite");
  let workspace = await openAgentWorkspace({ storagePath, models: f.models });
  t.after(() => workspace.close());
  const a = await workspace.execute("create", {
    cwd: f.cwd,
    name: "Persistent",
    model: { provider: "desk-test", modelId: "local" },
    tools: ["read"],
  });
  f.faux.setResponses([fauxAssistantMessage("persisted")]);
  const sent = await workspace.execute("send", {
    id: a.id,
    message: "hello",
    requestId: "persistent-id",
  });
  await settled(workspace, a.id);
  await assert.rejects(
    openAgentWorkspace({ storagePath, models: f.models }),
    /占用/,
  );
  await workspace.close();
  workspace = await openAgentWorkspace({ storagePath, models: f.models });
  const state = await workspace.read(a.id);
  assert.equal(state.active.name, "Persistent");
  assert.deepEqual(state.active.tools, ["read"]);
  assert(state.active.messages.some((row) => row.text === "persisted"));
  const resent = await workspace.execute("send", {
    id: a.id,
    message: "hello",
    requestId: "persistent-id",
  });
  assert.equal(resent.submissionId, sent.submissionId);
});

test("runtime environment overrides and the shipped extension operate through the Durable registry", async (t) => {
  const { default: extension } = await import("../examples/desk-extension.mjs");
  const f = await workspaceFixture(t, { extensions: [extension] });
  await writeFile(
    join(f.cwd, "package.json"),
    JSON.stringify({ name: "isolated-project" }),
  );
  const agent = await f.create(f.cwd, {
    shellEnv: { DESK_TEST_VAR: "private-environment-value" },
  });
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "project-call",
          name: "project_info",
          arguments: {},
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "shell-call",
          name: "bash",
          arguments: { command: 'printf "%s" "$DESK_TEST_VAR"' },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("complete"),
  ]);
  assert(
    !JSON.stringify(await f.workspace.read(agent.id)).includes(
      "private-environment-value",
    ),
  );
  await f.workspace.execute("send", {
    id: agent.id,
    message: "check environment",
    requestId: "env-request",
  });
  const state = await settled(f.workspace, agent.id);
  assert(
    state.active.messages.some(
      (row) =>
        row.toolName === "project_info" && row.text === "isolated-project",
    ),
  );
  assert(
    state.active.messages.some(
      (row) =>
        row.toolName === "bash" &&
        row.text.includes("private-environment-value"),
    ),
  );
  assert.deepEqual(state.active.environmentKeys, ["DESK_TEST_VAR"]);
});

test("busy configuration is rejected and a history fork keeps its project and selected tools", async (t) => {
  const f = await workspaceFixture(t);
  const agent = await f.create(f.cwd, { tools: ["read"] });
  f.faux.setResponses([
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return fauxAssistantMessage("branch answer");
    },
  ]);
  await f.workspace.execute("send", {
    id: agent.id,
    message: "question before fork",
    requestId: "branch-input",
  });
  await assert.rejects(
    f.workspace.execute("configure", { id: agent.id, name: "race" }),
    /空闲/,
  );
  const state = await settled(f.workspace, agent.id);
  const source = state.active.messages.find((row) => row.role === "assistant");
  const branch = await f.workspace.execute("fork", {
    id: agent.id,
    entryId: source.entryId,
  });
  const forked = await f.workspace.read(branch.id);
  assert.equal(forked.active.cwd, f.cwd);
  assert.deepEqual(forked.active.tools, ["read"]);
  assert(
    forked.active.messages.some((row) => row.text === "question before fork"),
  );
});

test("a projectless model can read outside its context but cannot execute forged write or bash calls", async (t) => {
  const f = await workspaceFixture(t, { readOnly: true });
  const path = join(f.other, "outside.txt");
  await writeFile(path, "read-only content");
  const agent = await f.create();
  assert.deepEqual([...(await f.workspace.agent(agent.id)).tools].sort(), [
    "read",
    "web_fetch",
    "web_search",
  ]);
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "blocked-write",
          name: "write",
          arguments: { path, content: "changed" },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "blocked-bash",
          name: "bash",
          arguments: { command: "touch denied.txt" },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "allowed-read",
          name: "read",
          arguments: { path },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  await f.workspace.execute("send", {
    id: agent.id,
    message: "read the file",
    requestId: "readonly-model",
  });
  const result = await settled(f.workspace, agent.id);
  assert.equal(await readFile(path, "utf8"), "read-only content");
  assert(
    result.active.messages.some(
      (row) =>
        row.role === "toolResult" && row.text.includes("read-only content"),
    ),
  );
  assert(
    result.active.messages.some(
      (row) => row.role === "toolResult" && row.isError,
    ),
  );
  await assert.rejects(readFile(join(f.cwd, "denied.txt")), { code: "ENOENT" });
  await assert.rejects(
    f.workspace.execute("configure", { id: agent.id, tools: ["bash"] }),
    (error) => error.status === 403,
  );
});

test("compaction keeps durable billing totals and invalidates the old context measurement until a new response", async (t) => {
  const f = await workspaceFixture(t, {
    settings: {
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1024 },
    },
  });
  const agent = await f.create();
  for (const message of ["first message", "second message"]) {
    f.faux.setResponses([fauxAssistantMessage(`response ${message}`)]);
    await f.workspace.execute("send", {
      id: agent.id,
      message,
      requestId: message,
    });
    await settled(f.workspace, agent.id);
  }
  const before = (await f.workspace.read(agent.id)).active;
  assert(before.usage.tokens > 0);
  assert(before.contextUsage.tokens > 0);
  f.faux.setResponses([
    fauxAssistantMessage("Summary of earlier conversation"),
  ]);
  await f.workspace.execute("compact", { id: agent.id });
  const deadline = Date.now() + 5000;
  let compacted;
  while (Date.now() < deadline) {
    compacted = (await f.workspace.read(agent.id)).active;
    if (compacted.idle && compacted.usage.tokens > before.usage.tokens) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(compacted.usage.tokens > before.usage.tokens);
  assert.equal(compacted.contextUsage.tokens, null);
  assert.equal(compacted.contextUsage.percent, null);
  f.faux.setResponses([fauxAssistantMessage("response after compact")]);
  await f.workspace.execute("send", {
    id: agent.id,
    message: "continue",
    requestId: "after-compact",
  });
  const after = (await settled(f.workspace, agent.id)).active;
  assert(after.contextUsage.tokens > 0);
  assert(after.usage.tokens > compacted.usage.tokens);
});
