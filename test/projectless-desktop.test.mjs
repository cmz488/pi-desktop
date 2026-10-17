import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { readOnlyEnvironment, readWeb } from "../src/agent/read-only-tools.mjs";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

test("read-only environment allows filesystem reads and denies every mutation and shell", async () => {
  const calls = [];
  const env = readOnlyEnvironment({
    cwd: "/tmp",
    readTextFile: async (path) => {
      calls.push(path);
      return { ok: true, value: "read" };
    },
    exec: async () => calls.push("exec"),
    writeFile: async () => calls.push("write"),
    appendFile: async () => calls.push("append"),
    remove: async () => calls.push("remove"),
    renameFile: async () => calls.push("rename"),
    createDir: async () => calls.push("mkdir"),
    truncateFile: async () => calls.push("truncate"),
    flushFile: async () => calls.push("flush"),
    createTempDir: async () => calls.push("temp"),
    createTempFile: async () => calls.push("tempfile"),
  });
  assert.equal((await env.readTextFile("/outside-project/file")).value, "read");
  for (const method of [
    "exec",
    "writeFile",
    "appendFile",
    "remove",
    "renameFile",
    "createDir",
    "truncateFile",
    "flushFile",
    "createTempDir",
    "createTempFile",
  ]) {
    const result = await env[method]();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "permission_denied");
  }
  assert.deepEqual(calls, ["/outside-project/file"]);
});

test("web reading uses bounded GET, preserves links and removes executable HTML", async () => {
  const result = await readWeb(
    "https://example.test",
    {},
    async (url, options) => {
      assert.equal(options.method, "GET");
      assert.equal(String(url), "https://example.test/");
      return new Response(
        '<script>delete files</script><style>body{}</style><a href="https://source.test">Source</a> &amp; text',
        { headers: { "content-type": "text/html" } },
      );
    },
  );
  assert.match(result.text, /Source \[https:\/\/source.test\]/);
  assert(!result.text.includes("delete files"));
  await assert.rejects(readWeb("file:///etc/passwd", {}), /HTTP/);
  await assert.rejects(
    readWeb(
      "https://large.test",
      {},
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ),
    /2 MiB/,
  );
});

test(
  "desktop opens a durable projectless chat, sends messages, manages plugins and never grants editing tools",
  { timeout: 60000 },
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
    const chat = catalog.agents.find((row) => row.projectId === null);
    assert.equal(chat.permissions, "read-only");
    const state = await f.call("/agents/" + chat.id + "/api/state");
    assert.equal(state.capabilities.readOnly, true);
    assert.notEqual(state.cwd, f.cwd);
    assert.deepEqual([...state.tools].sort(), [
      "agent_browser",
      "read",
      "web_fetch",
      "web_search",
    ]);
    const descriptor = await f.call("/agents/" + chat.id + "/api/agent");
    assert(!JSON.stringify(descriptor.active.tools).includes("bash"));
    for (const tools of [["write"], ["bash"], ["codemode"], ["read", "edit"]]) {
      await assert.rejects(
        f.call("/agents/" + chat.id + "/api/command", {
          command: "configure",
          id: Number(state.sessionId),
          tools,
        }),
        (error) => error.status === 403,
      );
    }
    await assert.rejects(
      f.call("/agents/" + chat.id + "/api/git", {
        sessionId: state.sessionId,
        action: "stage",
      }),
      (error) => error.status === 403,
    );
    await f.call("/agents/" + chat.id + "/api/prompt", {
      message: "hello without project",
      sessionId: state.sessionId,
      requestId: "projectless",
    });
    const answered = await until(
      () => f.call("/agents/" + chat.id + "/api/state"),
      (value) =>
        value.idle && value.messages.some((row) => row.role === "assistant"),
    );
    assert(
      answered.messages.some((row) =>
        row.text.includes("answer: hello without project"),
      ),
    );
    const plugin = join(f.root, "local-plugin");
    await mkdir(plugin);
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        name: "desktop-local-fixture",
        version: "1.0.0",
        pi: { extensions: ["extension.mjs"] },
      }),
    );
    await writeFile(
      join(plugin, "extension.mjs"),
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(f.root, "extension-loaded.txt"))}, "loaded"); export default pi => { pi.registerTool({name:"unsafe_fixture",label:"Unsafe",description:"must not load in projectless",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"unsafe"}]})}); };`,
    );
    const endpoint = "/agents/" + chat.id;
    await f.call(endpoint + "/api/package", {
      action: "install",
      source: plugin,
      scope: "global",
      sessionId: state.sessionId,
    });
    let inventory = await f.call(endpoint + "/api/plugins");
    let row = inventory.rows.find((row) => row.source.endsWith("local-plugin"));
    const installedSource = row?.source;
    assert(row, JSON.stringify(inventory));
    await f.call(endpoint + "/api/plugin", {
      id: row.id,
      enabled: false,
      revision: row.revision,
      sessionId: state.sessionId,
    });
    inventory = await f.call(endpoint + "/api/plugins");
    row = inventory.rows.find((row) => row.source === installedSource);
    assert.equal(row.enabled, false);
    await f.call(endpoint + "/api/plugin", {
      id: row.id,
      enabled: true,
      revision: row.revision,
      sessionId: state.sessionId,
    });
    inventory = await f.call(endpoint + "/api/plugins");
    row = inventory.rows.find((row) => row.source === installedSource);
    assert.equal(row.enabled, true);
    await f.call(endpoint + "/api/package", {
      action: "update",
      source: installedSource,
      scope: "global",
      sessionId: state.sessionId,
      revision: row.revision,
      inventoryKey: inventory.inventoryKey,
    });
    await f.call(endpoint + "/api/reload", { sessionId: state.sessionId });
    await assert.rejects(readFile(join(f.root, "extension-loaded.txt")), {
      code: "ENOENT",
    });
    const projectAgent = await f.command("conversation.create", {
      projectId: catalog.projects[0].id,
      name: "plugin agent",
    });
    const projectEndpoint = "/agents/" + projectAgent.id;
    const projectState = await f.call(projectEndpoint + "/api/state");
    assert(projectState.tools.includes("unsafe_fixture"));
    assert.equal(
      await readFile(join(f.root, "extension-loaded.txt"), "utf8"),
      "loaded",
    );
    inventory = await f.call(endpoint + "/api/plugins");
    row = inventory.rows.find((row) => row.source === installedSource);
    await f.call(endpoint + "/api/plugin", {
      id: row.id,
      enabled: false,
      revision: row.revision,
      sessionId: state.sessionId,
    });
    await f.call(projectEndpoint + "/api/reload", {
      sessionId: projectState.sessionId,
    });
    assert(
      !(await f.call(projectEndpoint + "/api/state")).tools.includes(
        "unsafe_fixture",
      ),
    );
    inventory = await f.call(endpoint + "/api/plugins");
    row = inventory.rows.find((row) => row.source === installedSource);
    await f.call(endpoint + "/api/plugin", {
      id: row.id,
      enabled: true,
      revision: row.revision,
      sessionId: state.sessionId,
    });
    await f.call(projectEndpoint + "/api/reload", {
      sessionId: projectState.sessionId,
    });
    assert(
      (await f.call(projectEndpoint + "/api/state")).tools.includes(
        "unsafe_fixture",
      ),
    );
    await f.command("agent.stop", { id: projectAgent.id });
    await f.call(endpoint + "/api/reload", { sessionId: state.sessionId });
    assert.deepEqual(
      [...(await f.call(endpoint + "/api/state")).tools].sort(),
      ["agent_browser", "read", "web_fetch", "web_search"],
    );
    inventory = await f.call(endpoint + "/api/plugins");
    row = inventory.rows.find((row) => row.source === installedSource);
    await f.call(endpoint + "/api/package", {
      action: "remove",
      source: installedSource,
      scope: "global",
      sessionId: state.sessionId,
      revision: row.revision,
      inventoryKey: inventory.inventoryKey,
    });
    assert(
      !(await f.call(endpoint + "/api/plugins")).rows.some(
        (row) => row.source === installedSource,
      ),
    );
    const newChat = await f.command("conversation.create", {
      name: "another chat",
    });
    assert.equal(
      (await f.call("/api/workspace")).agents.find(
        (row) => row.id === newChat.id,
      ).status,
      "running",
    );
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.filter((row) => row.status === "running").length === 2,
    );
    assert.deepEqual(
      (await f.call(endpoint + "/api/state")).messages,
      answered.messages,
    );
    const outside = join(f.other, "read.txt");
    await writeFile(outside, "outside root");
    const env = readOnlyEnvironment(new NodeExecutionEnv({ cwd: state.cwd }));
    assert.equal(
      (await env.readTextFile(outside, BACKGROUND_CONTEXT)).value,
      "outside root",
    );
    assert.equal(
      (await env.writeFile(outside, "changed", BACKGROUND_CONTEXT)).ok,
      false,
    );
    assert.equal(await readFile(outside, "utf8"), "outside root");
  },
);
