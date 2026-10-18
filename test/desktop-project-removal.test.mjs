import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  embeddedPiSdk as sdk,
  loadEmbeddedPiSdk,
} from "../src/agent/pi-sdk.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { openDesktopStore } from "../src/control-plane/store.mjs";
import { createSupervisor } from "../src/control-plane/supervisor.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";

await loadEmbeddedPiSdk();
async function native(f, name) {
  const manager = sdk.SessionManager.create(
    f.cwd,
    await nativeSessionDirectory(f.cwd, f.agentDir),
  );
  manager.appendSessionInfo(name);
  manager.appendMessage({
    role: "user",
    content: "Temporary history",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Temporary answer" }],
    api: "openai-completions",
    provider: "desktop-fixture",
    model: "local",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return manager;
}

test(
  "removing a workspace hides its chats without deleting Pi files, SQLite archives or metadata; adding it back restores the same IDs",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const project = (await f.call("/api/workspace")).projects[0];
    const other = await f.command("project.save", { cwd: f.other });
    const otherAgent = await f.command("agent.save", { projectId: other.id });
    const projectless = await f.command("agent.save", { projectId: null });
    const managed = await f.command("agent.save", { projectId: project.id });
    const live = await native(f, "Kept JSONL"),
      archived = await native(f, "Kept SQLite");
    const found = await until(
      () => f.call("/api/workspace"),
      (catalog) =>
        catalog.agents.some(
          (row) => row.nativeSessionId === archived.getSessionId(),
        ),
    );
    const liveRow = found.agents.find(
      (row) => row.nativeSessionId === live.getSessionId(),
    );
    const archivedRow = found.agents.find(
      (row) => row.nativeSessionId === archived.getSessionId(),
    );
    await f.command("agent.archive", { id: archivedRow.id });
    await f.call(`/agents/${liveRow.id}/api/state`);
    const original = await readFile(live.getSessionFile(), "utf8");
    const sourceFile = join(f.cwd, "keep.txt");
    await writeFile(sourceFile, "workspace files stay");
    assert.deepEqual(await f.command("project.remove", { id: project.id }), {
      id: project.id,
      removed: true,
    });
    const visible = await f.call("/api/workspace");
    assert(!visible.projects.some((row) => row.id === project.id));
    assert(!visible.agents.some((row) => row.projectId === project.id));
    assert(
      visible.agents.some(
        (row) => row.id === projectless.id && row.projectId === null,
      ),
    );
    assert(visible.agents.some((row) => row.id === otherAgent.id));
    assert.equal(await readFile(live.getSessionFile(), "utf8"), original);
    assert.equal(await readFile(sourceFile, "utf8"), "workspace files stay");
    const raw = JSON.parse(
      await readFile(join(f.directory, "workspace.json"), "utf8"),
    );
    assert(raw.projects.find((row) => row.id === project.id).removedAt);
    assert.equal(
      raw.agents.find((row) => row.id === managed.id).projectId,
      project.id,
    );
    assert(raw.agents.find((row) => row.id === archivedRow.id).archived);
    const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"), {
      readOnly: true,
    });
    assert(
      db.prepare("SELECT raw FROM sessions WHERE id=?").get(archivedRow.id).raw,
    );
    db.close();
    await assert.rejects(
      f.call(`/agents/${liveRow.id}/api/state`),
      (error) => error.status === 404,
    );
    await assert.rejects(
      f.command("agent.start", { id: managed.id }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      f.command("agent.restore", { id: archivedRow.id }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      f.command("conversation.create", { projectId: project.id }),
      (error) => error.status === 404,
    );
    assert.deepEqual(await f.command("project.remove", { id: project.id }), {
      id: project.id,
      removed: true,
    });
    await f.reopen();
    const afterRestart = await f.call("/api/workspace");
    assert(!afterRestart.projects.some((row) => row.cwd === f.cwd));
    assert(!afterRestart.agents.some((row) => row.projectId === project.id));
    // A newly discovered TUI chat cannot revive a removed workspace either.
    const hidden = await native(f, "New hidden TUI history");
    await new Promise((resolve) => setTimeout(resolve, 5100));
    assert(
      !(await f.call("/api/workspace")).projects.some(
        (row) => row.cwd === f.cwd,
      ),
    );
    assert.equal(
      await f.app.supervisor.shared(() => "shared works"),
      "shared works",
    );
    const restored = await f.command("project.save", {
      cwd: f.cwd,
      name: "Added again",
    });
    assert.equal(restored.id, project.id);
    const restoredCatalog = await f.call("/api/workspace");
    assert.equal(
      restoredCatalog.projects.find((row) => row.id === project.id).name,
      "Added again",
    );
    for (const id of [managed.id, liveRow.id, archivedRow.id])
      assert(
        restoredCatalog.agents.some(
          (row) => row.id === id && row.projectId === project.id,
        ),
      );
    assert(
      restoredCatalog.agents.find((row) => row.id === archivedRow.id).archived,
    );
    const rediscovered = await until(
      () => f.call("/api/workspace"),
      (catalog) =>
        catalog.agents.some(
          (row) => row.nativeSessionId === hidden.getSessionId(),
        ),
    );
    assert.equal(
      rediscovered.projects.filter((row) => row.cwd === f.cwd).length,
      1,
    );
    assert.equal(await readFile(live.getSessionFile(), "utf8"), original);
  },
);

test(
  "a running project must be explicitly stopped before it can be removed",
  { timeout: 20000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const projectId = (await f.call("/api/workspace")).projects[0].id;
    const agent = await f.command("conversation.create", { projectId });
    const started = Date.now();
    await assert.rejects(
      f.command("project.remove", { id: projectId }),
      (error) => error.status === 409 && /停止/.test(error.message),
    );
    assert(Date.now() - started < 1000);
    assert.equal(
      (await f.call("/api/workspace")).agents.find((row) => row.id === agent.id)
        .status,
      "running",
    );
    await f.command("agent.stop", { id: agent.id });
    await f.command("project.remove", { id: projectId });
    await assert.rejects(
      f.command("project.remove", { id: "unknown" }),
      (error) => error.status === 404,
    );
  },
);

test(
  "starting and stopping projects reject removal before waiting for the lifecycle queue",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-project-removal-"));
    const cwd = join(root, "project"),
      agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const store = await openDesktopStore(join(root, "data"));
    let launches = 0,
      ready,
      finishStop,
      cleanup = false;
    const supervisor = createSupervisor(store, {
      directory: join(root, "data"),
      agentDir,
      launch: () => {
        launches++;
        return {
          child: Object.assign(new EventEmitter(), { pid: 12345 }),
          ready: new Promise((resolve) => {
            ready = resolve;
          }),
          stop: () =>
            cleanup
              ? Promise.resolve()
              : new Promise((resolve) => {
                  finishStop = resolve;
                }),
        };
      },
    });
    t.after(async () => {
      cleanup = true;
      ready?.({ url: "http://127.0.0.1:9" });
      finishStop?.();
      await supervisor.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    const project = await store.project({ cwd });
    const agent = await store.agent({ projectId: project.id });
    const start = supervisor.execute("agent.start", { id: agent.id });
    await until(async () => !!ready, Boolean);
    const quickRejection = async () =>
      assert.rejects(
        Promise.race([
          supervisor.execute("project.remove", { id: project.id }),
          new Promise((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("removal waited for lifecycle queue")),
              1000,
            );
            timer.unref();
          }),
        ]),
        (error) => error.status === 409,
      );
    await quickRejection();
    ready({ url: "http://127.0.0.1:9" });
    await start;
    const stopping = supervisor.execute("agent.stop", { id: agent.id });
    await until(async () => !!finishStop, Boolean);
    await quickRejection();
    finishStop();
    await stopping;
    await supervisor.execute("project.remove", { id: project.id });
    // Even stale desired metadata cannot boot a hidden project's worker.
    await store.update({}, (data) => {
      data.agents.find((row) => row.id === agent.id).desired = true;
    });
    await supervisor.restore();
    assert.equal(launches, 1);
  },
);
