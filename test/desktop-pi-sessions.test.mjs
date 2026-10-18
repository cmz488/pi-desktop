import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  embeddedPiSdk as sdk,
  loadEmbeddedPiSdk,
} from "../src/agent/pi-sdk.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import {
  nativeSessionDirectory,
  readNativeRecord,
  assertNoNativeTui,
} from "../src/session/pi-session-storage.mjs";
import {
  createPiSessions,
  projectPiRecord,
} from "../src/control-plane/pi-sessions.mjs";
await loadEmbeddedPiSdk();
const user = (text) => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "desktop-fixture",
  model: "local",
  usage: {
    input: 10,
    output: 2,
    cacheRead: 8,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});
async function native(f, cwd = f.other) {
  const manager = sdk.SessionManager.create(
    cwd,
    await nativeSessionDirectory(cwd, f.agentDir),
  );
  manager.appendModelChange("desktop-fixture", "local");
  manager.appendThinkingLevelChange("high");
  manager.appendSessionInfo("TUI history");
  manager.appendMessage(user("original TUI question"));
  manager.appendMessage(assistant("original TUI answer"));
  return manager;
}
test(
  "Pi TUI discovery, live transcript, SQLite archive, source-independent viewing and restore",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = await native(f),
      path = manager.getSessionFile();
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    );
    const row = catalog.agents.find((row) => row.source === "pi"),
      project = catalog.projects.find(
        (project) => project.id === row.projectId,
      );
    assert.equal(project.cwd, f.other);
    assert.equal(row.name, "TUI history");
    assert.equal(row.nativeSessionId, manager.getSessionId());
    assert.equal(row.status, "history");
    assert.equal(row.pid, undefined);
    const statePath = `/agents/${row.id}/api/state`;
    const state = await f.call(statePath);
    assert.equal(state.capabilities.nativeHistory, true);
    assert.equal(state.model.id, "local");
    assert.equal(state.thinkingLevel, "high");
    assert.equal(state.messages.length, 2);
    const bytes = await readFile(path, "utf8");
    await assert.rejects(
      f.call(`/agents/${row.id}/api/prompt`, { message: "forbidden" }),
      (error) => error.status === 403,
    );
    assert.equal(await readFile(path, "utf8"), bytes);
    assert.equal(f.requests.length, 0);
    manager.appendMessage(user("live TUI append"));
    assert.equal(
      (await f.call(statePath)).messages.at(-1).text,
      "live TUI append",
    );
    await f.command("agent.rename", { id: row.id, name: "Desktop label" });
    await f.command("agent.pin", { id: row.id });
    const archivedBytes = await readFile(path, "utf8");
    await f.command("agent.archive", { id: row.id });
    await assert.rejects(readFile(path), (error) => error.code === "ENOENT");
    assert.equal(
      (
        await sdk.SessionManager.listAll(
          await nativeSessionDirectory(f.other, f.agentDir),
        )
      ).some((info) => info.id === manager.getSessionId()),
      false,
    );
    const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      db.prepare("SELECT raw FROM sessions WHERE id=?").get(row.id).raw,
      archivedBytes,
    );
    db.close();
    const frozen = await f.call(statePath);
    assert.equal(frozen.archived, true);
    assert.equal(frozen.messages.at(-1).text, "live TUI append");
    await f.reopen();
    const persisted = (await f.call("/api/workspace")).agents.find(
      (agent) => agent.id === row.id,
    );
    assert.equal(persisted.archived, true);
    assert.equal(persisted.pinned, true);
    assert.equal(persisted.name, "Desktop label");
    assert.equal(persisted.missing, false);
    assert.deepEqual((await f.call(statePath)).messages, frozen.messages);
    await f.command("agent.restore", { id: row.id });
    assert.equal(await readFile(path, "utf8"), archivedBytes);
    assert.equal((await f.call(statePath)).archived, false);
  },
);
test(
  "Desktop writes real Pi JSONL, deduplicates discovery, and preserves raw usage through restart and archive",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture({ defaultConversation: true });
    t.after(() => f.close());
    const row = (
      await until(
        () => f.call("/api/workspace"),
        (catalog) => catalog.agents[0]?.status === "running",
      )
    ).agents[0];
    await f.call(`/agents/${row.id}/api/prompt`, {
      message: "Desktop JSONL",
      requestId: "native-jsonl",
    });
    await until(
      () => f.call(`/agents/${row.id}/api/state`),
      (state) =>
        state.idle &&
        state.messages.some((message) => message.role === "assistant"),
    );
    let catalog = await f.call("/api/workspace"),
      managed = catalog.agents.find((agent) => agent.id === row.id);
    const record = await readNativeRecord(
      managed.nativeSessionPath,
      f.agentDir,
    );
    assert(managed.nativeSessionPath.startsWith(join(f.agentDir, "sessions")));
    assert.equal(record.header.id, managed.nativeSessionId);
    const native = sdk.SessionManager.inMemory(
      undefined,
      undefined,
      record.entries,
    );
    assert.deepEqual(
      native.buildSessionContext().messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(
      native.buildSessionContext().messages.at(-1).usage.cacheRead,
      900,
    );
    assert.equal((await stat(record.path)).mode & 0o777, 0o600);
    await f.reopen();
    catalog = await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.find((agent) => agent.id === row.id)?.status === "running",
    );
    assert.equal(
      catalog.agents.filter(
        (agent) => agent.nativeSessionId === managed.nativeSessionId,
      ).length,
      1,
    );
    const restarted = await readNativeRecord(record.path, f.agentDir);
    assert.equal(
      restarted.entries.filter((entry) => entry.type === "message").length,
      2,
    );
    await assert.rejects(
      f.command("agent.archive", { id: row.id }),
      /先停止进程/,
    );
    await f.command("agent.stop", { id: row.id });
    await f.command("agent.archive", { id: row.id });
    await assert.rejects(
      readFile(record.path),
      (error) => error.code === "ENOENT",
    );
    assert.equal((await f.call(`/agents/${row.id}/api/state`)).archived, true);
    await f.command("agent.restore", { id: row.id });
    await f.command("agent.start", { id: row.id });
    assert.equal(
      (await f.call(`/agents/${row.id}/api/state`)).messages.length,
      2,
    );
  },
);
test(
  "Desktop resumes native Pi context and returns subsequent messages to the same JSONL, including re-takeover after TUI changes",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = await native(f),
      path = manager.getSessionFile();
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    );
    const row = catalog.agents.find((row) => row.source === "pi");
    await f.command("agent.resume", { id: row.id });
    let state = await f.call(`/agents/${row.id}/api/state`);
    assert.equal(state.capabilities.durable, true);
    assert.equal(state.thinkingLevel, "high");
    assert.equal(state.messages.length, 2);
    assert.equal(f.requests.length, 0);
    await f.call(`/agents/${row.id}/api/prompt`, {
      message: "continue in Desktop",
      requestId: "resume",
    });
    await until(
      () => f.call(`/agents/${row.id}/api/state`),
      (value) =>
        value.idle &&
        value.messages.at(-1)?.text === "answer: continue in Desktop",
    );
    assert(JSON.stringify(f.requests.at(-1)).includes("original TUI answer"));
    let record = await readNativeRecord(path, f.agentDir);
    assert.equal(record.header.id, manager.getSessionId());
    assert.equal(
      record.entries.filter((entry) => entry.type === "message").length,
      4,
    );
    await f.command("agent.stop", { id: row.id });
    const continued = sdk.SessionManager.open(path);
    continued.appendMessage(user("new TUI turn"));
    continued.appendMessage(assistant("new TUI response"));
    await f.command("agent.resume", { id: row.id });
    state = await f.call(`/agents/${row.id}/api/state`);
    assert.equal(state.messages.length, 6);
    assert.equal(state.messages.at(-1).text, "new TUI response");
    const count = f.requests.length,
      external = sdk.SessionManager.open(path);
    external.appendMessage(user("concurrent external modification"));
    const changed = await readFile(path, "utf8");
    await assert.rejects(
      f.call(`/agents/${row.id}/api/prompt`, { message: "must not send" }),
      /修改/,
    );
    assert.equal(f.requests.length, count);
    assert.equal(await readFile(path, "utf8"), changed);
  },
);
test(
  "Pi branch and context edit projection, legacy session directory and native owner detection",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    await mkdir(join(f.agentDir, "session"));
    const manager = await native(f);
    assert(manager.getSessionFile().startsWith(join(f.agentDir, "session")));
    const first = manager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      );
    manager.branch(first.id);
    manager.appendMessage(assistant("active branch response"));
    manager.appendContextEdit(first.id, { content: "edited native question" });
    await writeFile(
      manager.getSessionFile(),
      (await readFile(manager.getSessionFile(), "utf8")) + '{"type":"message"',
    );
    const index = createPiSessions(f.agentDir);
    t.after(() => index.close());
    const rows = await index.scan(true);
    assert.equal(rows.length, 1);
    const state = await index.read(rows[0].id);
    assert.deepEqual(
      state.messages.map((message) => message.text),
      ["edited native question", "active branch response"],
    );
    assert.deepEqual(
      projectPiRecord(
        await readNativeRecord(manager.getSessionFile(), f.agentDir),
        rows[0].id,
      ).messages,
      state.messages,
    );
    const cli = join(f.root, "pi");
    await writeFile(cli, "setInterval(()=>{},1000)");
    const child = spawn(process.execPath, [cli], {
      cwd: f.other,
      stdio: "ignore",
    });
    t.after(() => child.kill());
    await new Promise((resolve) => child.once("spawn", resolve));
    await assert.rejects(assertNoNativeTui(f.other), /TUI 运行/);
  },
);

test(
  "resume preserves native images, tool results, compaction context and excludes abandoned history from new model requests",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = await native(f);
    const kept = manager.appendMessage(user("kept context"));
    manager.appendMessage({
      ...assistant(""),
      content: [
        {
          type: "thinking",
          thinking: "Native thought",
          thinkingSignature: "fixture-signature",
        },
        {
          type: "toolCall",
          id: "native-tool",
          name: "read",
          arguments: { path: "fixture.txt" },
        },
      ],
      stopReason: "toolUse",
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "native-tool",
      toolName: "read",
      content: [{ type: "text", text: "native tool result" }],
      details: { native: true },
      isError: false,
      timestamp: Date.now(),
    });
    manager.appendMessage({
      ...user(""),
      content: [
        { type: "text", text: "native image" },
        { type: "image", mimeType: "image/png", data: "fixture-image-bytes" },
      ],
    });
    manager.appendCustomEntry("fixture-native-state", { counter: 7 });
    manager.appendCustomMessageEntry(
      "pi-goal-audit-event",
      "目标验收通过",
      true,
      { phase: "approved", goalId: "fixture-goal" },
    );
    manager.appendCompaction("Original conversation summary", kept, 200);
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    );
    const row = catalog.agents.find((row) => row.source === "pi");
    const history = await f.call(`/agents/${row.id}/api/state`);
    assert(
      history.messages.some(
        (message) => message.text === "original TUI question",
      ),
    );
    assert(
      history.messages.some(
        (message) =>
          message.role === "custom" &&
          message.extensionView?.adapterId === "pi-goal-x" &&
          message.extensionView?.status === "验收通过",
      ),
    );
    await f.command("agent.resume", { id: row.id });
    const record = await readNativeRecord(manager.getSessionFile(), f.agentDir);
    assert(
      record.entries.some(
        (entry) =>
          entry.type === "compaction" &&
          entry.summary === "Original conversation summary",
      ),
    );
    assert(
      record.entries.some((entry) =>
        entry.message?.content?.some?.(
          (block) => block.thinkingSignature === "fixture-signature",
        ),
      ),
    );
    assert(
      record.entries.some((entry) =>
        entry.message?.content?.some?.(
          (block) => block.data === "fixture-image-bytes",
        ),
      ),
    );
    await f.call(`/agents/${row.id}/api/prompt`, {
      message: "continue after compaction",
      requestId: "compacted",
    });
    await until(
      () => f.call(`/agents/${row.id}/api/state`),
      (state) =>
        state.idle &&
        state.messages.at(-1)?.text === "answer: continue after compaction",
    );
    const request = JSON.stringify(f.requests.at(-1));
    assert(request.includes("Original conversation summary"));
    assert(request.includes("kept context"));
    assert(request.includes("native tool result"));
    assert(request.includes("目标验收通过"));
    assert(
      f.requests.at(-1).messages.every((message) => message.role !== "custom"),
    );
    assert(!request.includes("original TUI question"));
  },
);

for (const compacted of [false, true]) {
  test(`native custom messages preserve their cards and continue through restart (${compacted ? "compacted" : "uncompacted"})`, async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = await native(f);
    const kept = manager.appendMessage(user("keep this context"));
    const content = compacted
      ? [{ type: "text", text: "native notice" }]
      : "native notice";
    const entryId = manager.appendCustomMessageEntry(
      "fixture-native-notice",
      content,
      true,
      {
        piDesktop: {
          version: 1,
          title: "Native notice",
          body: "Card preserved",
        },
      },
    );
    const original = manager.getEntry(entryId);
    if (compacted) manager.appendCompaction("native summary", kept, 200);
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    );
    const row = catalog.agents.find((row) => row.source === "pi");
    await f.command("agent.resume", { id: row.id });
    const path = `/agents/${row.id}/api/state`;
    for (let turn = 0; turn < 2; turn++) {
      if (turn) {
        await f.command("agent.stop", { id: row.id });
        const stored = (await f.call("/api/workspace")).agents.find(
          (agent) => agent.id === row.id,
        );
        const database = new DatabaseSync(
          join(
            f.directory,
            "agents",
            row.id,
            `resume-${stored.generation}`,
            "agents.sqlite",
          ),
        );
        try {
          // Recreate the previous importer's on-disk representation in this
          // isolated fixture, then exercise the real worker startup migration.
          let changed = 0;
          for (const record of database
            .prepare("SELECT id, record FROM entries")
            .all()) {
            const entry = JSON.parse(record.record);
            if (!entry.data?.nativeMessage) continue;
            entry.model = [entry.data.nativeMessage];
            delete entry.data.nativeMessage;
            database
              .prepare("UPDATE entries SET record = ? WHERE id = ?")
              .run(JSON.stringify(entry), record.id);
            changed++;
          }
          assert.equal(changed, 1);
        } finally {
          database.close();
        }
        await f.command("agent.start", { id: row.id });
      }
      const before = await f.call(path);
      const cards = before.messages.filter(
        (message) => message.customType === "fixture-native-notice",
      );
      assert.equal(cards.length, 1);
      assert.equal(cards[0].extensionView.title, "Native notice");
      await f.call(`/agents/${row.id}/api/prompt`, {
        message: `continue ${turn}`,
        requestId: `native-custom-${turn}`,
      });
      await until(
        () => f.call(path),
        (state) =>
          state.idle &&
          state.messages.at(-1)?.text === `answer: continue ${turn}`,
        3000,
      );
      const request = f.requests.at(-1);
      assert(request.messages.every((message) => message.role !== "custom"));
      assert.equal(
        JSON.stringify(request).split("native notice").length - 1,
        1,
      );
      const restored = await readNativeRecord(
        manager.getSessionFile(),
        f.agentDir,
      );
      assert.deepEqual(
        restored.entries.find((entry) => entry.id === entryId),
        original,
      );
      assert.equal(restored.header.id, manager.getSessionId());
      assert.equal(
        restored.entries.filter((entry) => entry.type === "context_edit")
          .length,
        0,
        "a Durable representation repair must not become a native user context edit",
      );
    }
  });
}

test(
  "legacy Desktop SQLite history is exported without resuming tasks or invoking models, including existing archives",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const id = (
      await f.command("conversation.create", {
        projectId: (await f.call("/api/workspace")).projects[0].id,
      })
    ).id;
    await f.call(`/agents/${id}/api/prompt`, {
      message: "legacy conversation",
      requestId: "legacy",
    });
    await until(
      () => f.call(`/agents/${id}/api/state`),
      (value) =>
        value.idle &&
        value.messages.some((message) => message.role === "assistant"),
    );
    await f.command("agent.stop", { id });
    await f.command("agent.archive", { id });
    const before = f.requests.length,
      record = (await f.call("/api/workspace")).agents.find(
        (row) => row.id === id,
      );
    await f.app.stop();
    await rm(record.nativeSessionPath, { force: true });
    await rm(join(f.directory, "agents", id, "native-session.json"));
    const path = join(f.directory, "workspace.json"),
      catalog = JSON.parse(await readFile(path, "utf8")),
      old = catalog.agents.find((row) => row.id === id);
    delete old.nativeSessionId;
    delete old.nativeSessionPath;
    delete old.archiveStored;
    await writeFile(path, JSON.stringify(catalog));
    const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"));
    db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    db.close();
    await f.reopen();
    const migrated = (
      await until(
        () => f.call("/api/workspace"),
        (value) => value.agents.find((row) => row.id === id)?.archiveStored,
      )
    ).agents.find((row) => row.id === id);
    assert.equal(migrated.archived, true);
    assert.equal(migrated.status, "stopped");
    assert.equal(f.requests.length, before);
    assert.equal(migrated.nativeSessionId, id);
    const state = await f.call(`/agents/${id}/api/state`);
    assert.equal(state.messages.length, 2);
    assert.deepEqual(
      state.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(state.messages.at(-1).text, "answer: legacy conversation");
    assert.equal(state.archived, true);
  },
);

test(
  "a stopped projectless Desktop transcript can resume while preserving its read-only tool scope",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture({ defaultConversation: true });
    t.after(() => f.close());
    const row = (
      await until(
        () => f.call("/api/workspace"),
        (value) =>
          value.agents.some(
            (row) => row.projectId === null && row.status === "running",
          ),
      )
    ).agents.find((row) => row.projectId === null);
    await f.call(`/agents/${row.id}/api/prompt`, {
      message: "projectless native history",
      requestId: "projectless-history",
    });
    await until(
      () => f.call(`/agents/${row.id}/api/state`),
      (value) =>
        value.idle &&
        value.messages.some((message) => message.role === "assistant"),
    );
    await f.command("agent.stop", { id: row.id });
    await f.command("agent.resume", { id: row.id });
    const state = await f.call(`/agents/${row.id}/api/state`);
    assert.equal(state.capabilities.readOnly, true);
    assert.equal(state.messages.length, 2);
    const descriptor = await f.call(`/agents/${row.id}/api/agent`);
    assert(!descriptor.active.tools.includes("write"));
    assert(!descriptor.active.tools.includes("bash"));
  },
);

test("adding a conversation survives an unrelated discovery revision while existing-row updates still reject stale state", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const catalog = await f.call("/api/workspace"),
    project = catalog.projects[0];
  await f.command("project.rename", {
    id: project.id,
    name: "Updated workspace",
  });
  const row = await f.command("agent.save", {
    projectId: project.id,
    name: "Created from open form",
    revision: catalog.revision,
  });
  await assert.rejects(
    f.command("agent.pin", { id: row.id, revision: catalog.revision }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    f.command("project.save", { cwd: f.cwd, revision: catalog.revision }),
    /已添加/,
  );
});

test(
  "old incomplete exports rebuild from the full Durable journal with the original native session ID",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture({ defaultConversation: true });
    t.after(() => f.close());
    const row = (
      await until(
        () => f.call("/api/workspace"),
        (value) => value.agents[0]?.status === "running",
      )
    ).agents[0];
    for (const message of ["first backlog turn", "second backlog turn"]) {
      await f.call(`/agents/${row.id}/api/prompt`, {
        message,
        requestId: message,
      });
      await until(
        () => f.call(`/agents/${row.id}/api/state`),
        (value) =>
          value.idle && value.messages.at(-1)?.text === `answer: ${message}`,
      );
    }
    const state = await f.call(`/agents/${row.id}/api/state`);
    await f.command("agent.stop", { id: row.id });
    const stored = (await f.call("/api/workspace")).agents.find(
      (agent) => agent.id === row.id,
    );
    const record = await readNativeRecord(stored.nativeSessionPath, f.agentDir);
    const marker = record.entries.findLast(
      (entry) => entry.customType === "pi-desktop-sync",
    );
    const incomplete = sdk.SessionManager.inMemory(
      record.header.cwd,
      undefined,
      [record.header],
    );
    incomplete.appendMessage(
      record.entries.findLast((entry) => entry.type === "message").message,
    );
    incomplete.appendCustomEntry("pi-desktop-sync", {
      owner: `${row.id}:0`,
      conversation: Number(state.sessionId),
      through: marker.data.through,
      mapping: [],
    });
    await writeFile(
      record.path,
      [incomplete.getHeader(), ...incomplete.getEntries()]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await f.command("agent.start", { id: row.id });
    const repaired = await readNativeRecord(record.path, f.agentDir);
    assert.equal(repaired.header.id, record.header.id);
    assert.equal(
      repaired.entries.filter((entry) => entry.type === "message").length,
      4,
    );
    assert.deepEqual(
      sdk.SessionManager.inMemory(undefined, undefined, repaired.entries)
        .buildSessionContext()
        .messages.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.deepEqual(
      (await f.call(`/agents/${row.id}/api/state`)).messages,
      state.messages,
    );
  },
);

test("a native TUI owner blocks archival even when opened from another cwd, without changing JSONL or SQLite", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const manager = await native(f),
    path = manager.getSessionFile(),
    raw = await readFile(path, "utf8");
  const row = (
    await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    )
  ).agents.find((row) => row.source === "pi");
  const cli = join(f.root, "pi");
  await writeFile(cli, "setInterval(()=>{},1000)");
  const child = spawn(process.execPath, [cli, "--session", path], {
    cwd: f.cwd,
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));
  await assert.rejects(
    f.command("agent.archive", { id: row.id }),
    (error) => error.status === 409 && /TUI 运行/.test(error.message),
  );
  assert.equal(await readFile(path, "utf8"), raw);
  const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sessions WHERE id=?").get(row.id).n,
    0,
  );
  db.close();
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await stopped;
  await f.command("agent.archive", { id: row.id });
  await assert.rejects(readFile(path), (error) => error.code === "ENOENT");
});

test("failed SQLite persistence never removes a native file, and restoration never overwrites a colliding record", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  const manager = await native(f),
    path = manager.getSessionFile(),
    raw = await readFile(path, "utf8");
  const row = (
    await until(
      () => f.call("/api/workspace"),
      (value) => value.agents.some((row) => row.source === "pi"),
    )
  ).agents.find((row) => row.source === "pi");
  const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"));
  db.exec(
    "CREATE TRIGGER refuse_archive BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END",
  );
  await assert.rejects(f.command("agent.archive", { id: row.id }));
  assert.equal(await readFile(path, "utf8"), raw);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  db.exec("DROP TRIGGER refuse_archive");
  db.close();
  await f.command("agent.archive", { id: row.id });
  const collision = sdk.SessionManager.inMemory(f.other);
  collision.appendMessage(user("another session"));
  const otherRaw =
    [collision.getHeader(), ...collision.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  await writeFile(path, otherRaw);
  await assert.rejects(
    f.command("agent.restore", { id: row.id }),
    (error) => error.status === 409 && /未覆盖/.test(error.message),
  );
  assert.equal(await readFile(path, "utf8"), otherRaw);
  assert.equal(
    (await f.call("/api/workspace")).agents.find((agent) => agent.id === row.id)
      .archived,
    true,
  );
  await rm(path);
  await f.command("agent.restore", { id: row.id });
  assert.equal(await readFile(path, "utf8"), raw);
  assert.equal(
    (await readNativeRecord(path, f.agentDir)).header.id,
    manager.getSessionId(),
  );
});

test(
  "restart finishes interrupted archive and restore intents and reconciles catalog flags before any worker boots",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = await native(f),
      path = manager.getSessionFile(),
      raw = await readFile(path, "utf8");
    const row = (
      await until(
        () => f.call("/api/workspace"),
        (value) => value.agents.some((row) => row.source === "pi"),
      )
    ).agents.find((row) => row.source === "pi");
    await f.command("agent.archive", { id: row.id });
    await f.app.stop();
    // Reproduce the durable intent committed just before removing the source.
    await writeFile(path, raw);
    let db = new DatabaseSync(join(f.directory, "session-archives.sqlite"));
    db.prepare("UPDATE sessions SET phase='archiving' WHERE id=?").run(row.id);
    db.close();
    const catalogPath = join(f.directory, "workspace.json"),
      catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    Object.assign(
      catalog.agents.find((agent) => agent.id === row.id),
      { archived: false, archiveStored: false, desired: true, missing: true },
    );
    await writeFile(catalogPath, JSON.stringify(catalog));
    await f.reopen();
    await f.app.supervisor.restore();
    let actual = (await f.call("/api/workspace")).agents.find(
      (agent) => agent.id === row.id,
    );
    assert.equal(actual.archived, true);
    assert.equal(actual.desired, false);
    assert.equal(actual.missing, false);
    await assert.rejects(readFile(path), (error) => error.code === "ENOENT");
    assert.equal(
      (await f.call(`/agents/${row.id}/api/state`)).messages.length,
      2,
    );
    await f.app.stop();
    // Reproduce a restore interrupted after atomic publication, before the catalog.
    await writeFile(path, raw);
    db = new DatabaseSync(join(f.directory, "session-archives.sqlite"));
    db.prepare("UPDATE sessions SET phase='restoring' WHERE id=?").run(row.id);
    db.close();
    await f.reopen();
    await f.app.supervisor.restore();
    actual = (await f.call("/api/workspace")).agents.find(
      (agent) => agent.id === row.id,
    );
    assert.equal(actual.archived, false);
    assert.equal(actual.desired, false);
    assert.equal(await readFile(path, "utf8"), raw);
    assert.equal(
      (await readNativeRecord(path, f.agentDir)).header.id,
      manager.getSessionId(),
    );
    assert.equal(f.requests.length, 0);
  },
);

test(
  "older snapshot-only archives migrate to SQLite-only storage and an empty restored Desktop session keeps its original path",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = await native(f),
      path = manager.getSessionFile(),
      raw = await readFile(path, "utf8");
    const row = (
      await until(
        () => f.call("/api/workspace"),
        (value) => value.agents.some((row) => row.source === "pi"),
      )
    ).agents.find((row) => row.source === "pi");
    await f.command("agent.archive", { id: row.id });
    await f.app.stop();
    await writeFile(path, raw);
    const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"));
    db.prepare("UPDATE sessions SET phase='snapshot' WHERE id=?").run(row.id);
    db.close();
    await f.reopen();
    await f.app.supervisor.restore();
    await assert.rejects(readFile(path), (error) => error.code === "ENOENT");
    assert.equal(
      (await f.call(`/agents/${row.id}/api/state`)).messages.length,
      2,
    );
    const empty = await f.command("conversation.create", { projectId: null });
    const before = (await f.call("/api/workspace")).agents.find(
      (agent) => agent.id === empty.id,
    );
    await f.command("agent.stop", { id: empty.id });
    await f.command("agent.archive", { id: empty.id });
    await f.command("agent.restore", { id: empty.id });
    assert.equal(
      (await readNativeRecord(before.nativeSessionPath, f.agentDir)).header.id,
      before.nativeSessionId,
    );
    await f.command("agent.start", { id: empty.id });
    const after = (await f.call("/api/workspace")).agents.find(
      (agent) => agent.id === empty.id,
    );
    assert.equal(after.nativeSessionPath, before.nativeSessionPath);
    assert.equal(after.nativeSessionId, before.nativeSessionId);
  },
);
