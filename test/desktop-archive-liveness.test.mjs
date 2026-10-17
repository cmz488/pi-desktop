import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { embeddedPiSdk as sdk } from "../src/agent/pi-sdk.mjs";
import {
  nativeSessionDirectory,
  openSessionArchives,
} from "../src/session/pi-session-storage.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { openDesktopStore } from "../src/control-plane/store.mjs";
import { createSupervisor } from "../src/control-plane/supervisor.mjs";

test(
  "repeated archive requests preserve the original SQLite transcript and session identity",
  { timeout: 15000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = sdk.SessionManager.create(
      f.other,
      await nativeSessionDirectory(f.other, f.agentDir),
    );
    manager.appendSessionInfo("Archive retry fixture");
    manager.appendMessage({
      role: "user",
      content: "Must survive an uncertain response and manual retry",
      timestamp: Date.now(),
    });
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.nativeSessionId === manager.getSessionId(),
        ),
    );
    const row = catalog.agents.find(
      (value) => value.nativeSessionId === manager.getSessionId(),
    );
    const original = await readFile(manager.getSessionFile(), "utf8");
    await f.command("agent.archive", { id: row.id });
    await f.command("agent.archive", { id: row.id });
    const db = new DatabaseSync(join(f.directory, "session-archives.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT raw FROM sessions WHERE id=?").get(row.id).raw,
        original,
      );
    } finally {
      db.close();
    }
    await f.command("agent.restore", { id: row.id });
    assert.equal(await readFile(manager.getSessionFile(), "utf8"), original);
  },
);

test(
  "starting and stopping sessions reject archive without waiting for the lifecycle queue",
  { timeout: 10000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-archive-liveness-")),
      cwd = join(root, "project"),
      agentDir = join(root, "agent");
    await Promise.all([mkdir(cwd), mkdir(agentDir)]);
    const store = await openDesktopStore(join(root, "data"));
    let ready,
      finishStop,
      cleanup = false;
    const supervisor = createSupervisor(store, {
      directory: join(root, "data"),
      agentDir,
      launch: () => ({
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
      }),
    });
    t.after(async () => {
      cleanup = true;
      ready?.({ url: "http://127.0.0.1:9" });
      finishStop?.();
      await supervisor.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    });
    const project = await store.project({ cwd }),
      agent = await store.agent({ projectId: project.id });
    const start = supervisor.execute("agent.start", { id: agent.id });
    await until(async () => !!ready, Boolean);
    const quickRejection = async () => {
      let timeout;
      try {
        await assert.rejects(
          Promise.race([
            supervisor.execute("agent.archive", { id: agent.id }),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("archive waited for lifecycle queue")),
                1000,
              );
            }),
          ]),
          (error) => error.status === 409 && /停止/.test(error.message),
        );
      } finally {
        clearTimeout(timeout);
      }
    };
    await quickRejection();
    ready({ url: "http://127.0.0.1:9" });
    await start;
    const stopping = supervisor.execute("agent.stop", { id: agent.id });
    await until(async () => !!finishStop, Boolean);
    await quickRejection();
    finishStop();
    await stopping;
  },
);

test("the archive adapter is idempotent independently of catalog state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-archive-retry-")),
    cwd = join(root, "project"),
    agentDir = join(root, "agent");
  await mkdir(cwd);
  const manager = sdk.SessionManager.create(
    cwd,
    await nativeSessionDirectory(cwd, agentDir),
  );
  manager.appendMessage({
    role: "user",
    content: "Keep this message after an interrupted response",
    timestamp: Date.now(),
  });
  const path = manager.getSessionFile(),
    original = await readFile(path, "utf8"),
    archive = await openSessionArchives(join(root, "data"), agentDir);
  t.after(async () => {
    archive.close();
    await rm(root, { recursive: true, force: true });
  });
  const id = manager.getSessionId();
  await archive.archive(id, path, cwd, id);
  const repeated = await archive.archive(id, path, cwd, id);
  assert.equal(repeated.raw, original);
  assert.equal(archive.read(id).raw, original);
  await archive.restore(id);
  assert.equal(await readFile(path, "utf8"), original);
});

test(
  "archiving a selected native history finishes while its event stream remains open",
  { timeout: 15000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const manager = sdk.SessionManager.create(
      f.other,
      await nativeSessionDirectory(f.other, f.agentDir),
    );
    manager.appendMessage({
      role: "user",
      content: "Selected history fixture",
      timestamp: Date.now(),
    });
    const catalog = await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.some(
          (row) => row.nativeSessionId === manager.getSessionId(),
        ),
    );
    const row = catalog.agents.find(
      (value) => value.nativeSessionId === manager.getSessionId(),
    );
    await f.call(`/agents/${row.id}/api/state`);
    const controller = new AbortController(),
      response = await fetch(
        new URL(`/agents/${row.id}/api/events`, f.app.url),
        { signal: controller.signal },
      );
    t.after(() => controller.abort());
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    const started = performance.now();
    const deadline = setTimeout(() => controller.abort(), 3000);
    try {
      const origin = new URL(f.app.url).origin,
        archived = await fetch(new URL("/api/workspace/command", origin), {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ command: "agent.archive", id: row.id }),
          signal: controller.signal,
        });
      assert.equal(archived.status, 200);
      await archived.json();
      assert(performance.now() - started < 3000);
      assert.equal(
        (await f.call(`/agents/${row.id}/api/state`)).archived,
        true,
      );
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  },
);
