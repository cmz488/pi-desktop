import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopFixture } from "./desktop-fixture.mjs";
import { createSessionInventories } from "../src/shared/session-inventories.mjs";
import { chatSnapshot, createIndexedFetch } from "../src/shared/lazy-data.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDeskBridge } from "../src/server/bridge.mjs";

test("navigation transfers indexes, and unchanged indexes have no response body", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  await f.command("prompt.save", {
    name: "persona",
    instructions: "PRIVATE_PERSONA".repeat(800),
  });
  const catalog = await f.call("/api/workspace");
  const agent = await f.command("agent.save", {
    projectId: catalog.projects[0].id,
    name: "Lazy chat",
  });
  const response = await fetch(new URL("/api/workspace?view=index", f.app.url));
  const index = await response.json();
  assert.equal(
    index.promptProfiles[0].instructions,
    undefined,
    "navigation must not preload persona content",
  );
  assert.equal(
    index.agents.find((row) => row.id === agent.id).nativeSessionPath,
    undefined,
    "navigation must not transfer worker storage configuration",
  );
  assert.ok(response.headers.get("etag"));
  const unchanged = await fetch(
    new URL("/api/workspace?view=index", f.app.url),
    { headers: { "If-None-Match": response.headers.get("etag") } },
  );
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  const detail = await f.call(
    `/api/workspace/detail?kind=prompt&id=${index.promptProfiles[0].id}`,
  );
  assert.equal(detail.instructions, "PRIVATE_PERSONA".repeat(800));
});

test("chat pagination and collapsed tools omit unopened detail bodies", () => {
  const messages = Array.from({ length: 100 }, (_, id) => ({
    id,
    role: "assistant",
    text: "visible",
    blocks: [
      { type: "thinking", text: "secret thinking ".repeat(300) },
      { type: "toolCall", arguments: "arguments ".repeat(300) },
    ],
  }));
  messages.push({
    id: 100,
    role: "toolResult",
    text: "output ".repeat(5000),
    blocks: [{ type: "text", text: "output ".repeat(5000) }],
  });
  const snapshot = {
    active: { messages },
    models: [{ id: "unopened" }],
    tasks: ["journal"],
    commands: [
      { name: "unopened", description: "SKILL_DESCRIPTION".repeat(1000) },
    ],
    toolRegistrations: ["unopened registry"],
    messages,
  };
  const chat = chatSnapshot(snapshot);
  assert.equal(chat.messages.length, 50);
  assert(chat.historyMore);
  for (const field of [
    "active",
    "models",
    "tasks",
    "commands",
    "toolRegistrations",
  ])
    assert.equal(chat[field], undefined);
  assert.equal(chat.messages.at(-1).text.length, 160);
  assert.equal(chat.messages[0].blocks[0].text.length, 90);
  assert(JSON.stringify(chat).length < JSON.stringify(snapshot).length / 10);
  assert.equal(chatSnapshot(snapshot, 101).messages.length, 101);
});

test("chat detail API returns only the requested message and rejects unknown IDs", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const messages = [
    {
      id: "thought",
      role: "assistant",
      text: "Answer",
      blocks: [{ type: "thinking", text: "THINKING_BODY".repeat(1000) }],
    },
    {
      id: "output",
      role: "toolResult",
      text: "TOOL_BODY".repeat(1000),
      blocks: [],
    },
  ];
  const bridge = createDeskBridge({
    host: "127.0.0.1",
    port: 0,
    agentDir: f.agentDir,
    snapshot: () => ({ messages, models: ["unopened"], active: { messages } }),
  });
  const url = await bridge.start();
  t.after(() => bridge.stop());
  const chat = await (await fetch(new URL("/api/state?view=chat", url))).json();
  assert(chat.messages.every((row) => row.lazy && row.detailRevision));
  assert.equal(chat.models, undefined);
  const detail = await (
    await fetch(new URL("/api/message-detail?messageId=output", url))
  ).json();
  assert.deepEqual(detail, messages[1]);
  assert.equal(
    (await fetch(new URL("/api/message-detail?messageId=unknown", url))).status,
    404,
  );
  assert.equal(
    (await fetch(new URL("/api/state?view=chat&historyLimit=-1", url))).status,
    422,
  );
});

test("inventories do no work until a view asks for its own list", async () => {
  const calls = [];
  const inventories = createSessionInventories({
    load: async (kind) => {
      calls.push(kind);
      return {};
    },
    apply() {},
  });
  const snapshot = { sessionId: "chat" };
  await inventories.refresh(snapshot, { kinds: [] });
  assert.deepEqual(calls, []);
  await inventories.refresh(snapshot, { kinds: ["providers"] });
  assert.deepEqual(calls, ["providers"]);
  await inventories.refresh(snapshot, { kinds: ["providers"] });
  assert.deepEqual(calls, ["providers"]);
  await inventories.refresh(snapshot, { kinds: ["plugins"] });
  assert.deepEqual(calls, ["providers", "plugins"]);
});

test("private client validators reuse unchanged responses and evict bounded entries", async () => {
  const headers = [];
  const read = createIndexedFetch(async (_url, options) => {
    headers.push(options.headers.get("If-None-Match"));
    return headers.at(-1)
      ? new Response(null, { status: 304 })
      : new Response('{"name":"index"}', { headers: { ETag: 'W/"one"' } });
  }, 40);
  assert.deepEqual(await read("/one"), { name: "index" });
  assert.deepEqual(await read("/one"), { name: "index" });
  await read("/two");
  await read("/one");
  assert.deepEqual(headers, [null, 'W/"one"', null, null]);
});

test("directory indexes never upload nested file contents; clicking one file reads only that preview", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const project = (await f.call("/api/workspace")).projects[0];
  await mkdir(join(f.cwd, "nested"));
  await writeFile(join(f.cwd, "opened.txt"), "OPENED_ONLY".repeat(3000));
  await writeFile(join(f.cwd, "nested", "closed.txt"), "UNOPENED_CONTENT");
  const agent = await f.command("conversation.create", {
    projectId: project.id,
  });
  const choices = await f.call(`/agents/${agent.id}/api/providers?view=picker`);
  assert(
    choices.rows.some((row) =>
      row.models.some((model) => model.id === "local"),
    ),
  );
  assert(
    choices.rows.every((row) => !row.catalog && !row.auth && !row.baseUrl),
  );
  assert(
    choices.rows.every((row) =>
      row.models.every((model) =>
        Object.keys(model).every((key) =>
          ["id", "name", "available"].includes(key),
        ),
      ),
    ),
  );
  const chat = await f.call(`/agents/${agent.id}/api/state?view=chat`);
  assert.equal(chat.commands, undefined);
  assert.equal(chat.models, undefined);
  assert.ok(chat.commandsRevision);
  assert(
    (await f.call(`/agents/${agent.id}/api/commands`)).rows.some(
      (row) => row.name === "model",
    ),
  );
  const index = await f.call(`/agents/${agent.id}/api/files`);
  assert(!JSON.stringify(index).includes("OPENED_ONLY"));
  assert(!JSON.stringify(index).includes("closed.txt"));
  const response = await fetch(
    new URL(`/agents/${agent.id}/api/files?path=opened.txt`, f.app.url),
  );
  assert.equal((await response.json()).text, "OPENED_ONLY".repeat(3000));
  const unchanged = await fetch(
    new URL(`/agents/${agent.id}/api/files?path=opened.txt`, f.app.url),
    { headers: { "If-None-Match": response.headers.get("etag") } },
  );
  assert.equal(unchanged.status, 304);
});
